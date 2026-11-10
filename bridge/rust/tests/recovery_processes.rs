use razer_hid_helper::{
    process::{NativeProcessTable, Observation, ProcessIdentity, ProcessTable},
    recovery,
    session_guard::{load, SessionGuard},
};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};
fn directory() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "razer-recovery-process-{}-{}",
        std::process::id(),
        razer_hid_helper::process::nonce().unwrap()
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}
fn stop_fixture(identity: &ProcessIdentity) {
    use windows_sys::Win32::{Foundation::*, System::Threading::*};
    unsafe {
        let handle = OpenProcess(
            PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            identity.pid,
        );
        assert!(!handle.is_null());
        let (mut creation, mut exit, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        assert_ne!(
            GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user),
            0
        );
        assert_eq!(
            (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime),
            identity.creation_time,
            "only our exact fixture generation may be killed"
        );
        assert_ne!(TerminateProcess(handle, 9), 0);
        assert_eq!(WaitForSingleObject(handle, 5000), WAIT_OBJECT_0);
        CloseHandle(handle);
    }
}
#[test]
fn real_process_table_distinguishes_matching_active_reused_and_gone() {
    let mut table = NativeProcessTable;
    let mut child = Command::new(env!("CARGO_BIN_EXE_lifecycle-fixture"))
        .arg("--fixture-hold")
        .spawn()
        .unwrap();
    let identity = razer_hid_helper::process::child_identity(&child).unwrap();
    assert_eq!(table.observe(&identity).unwrap(), Observation::Active);
    let reused = ProcessIdentity {
        pid: identity.pid,
        creation_time: identity.creation_time + 1,
    };
    assert_eq!(table.observe(&reused).unwrap(), Observation::Reused);
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(matches!(
        table.observe(&identity).unwrap(),
        Observation::Signaled | Observation::Gone
    ));
    assert_eq!(
        table
            .observe(&ProcessIdentity {
                pid: u32::MAX,
                creation_time: 1
            })
            .unwrap(),
        Observation::Gone
    );
}
#[test]
fn killed_recovery_generations_wait_registered_children_and_unknown_spawn_never_clears() {
    for phase in ["adoption", "pending", "recovery-pending", "spawning"] {
        let path = directory().join("session.json");
        if phase == "adoption" || phase == "recovery-pending" {
            drop(SessionGuard::create_at(path.clone()).unwrap());
        }
        let mut parent = Command::new(env!("CARGO_BIN_EXE_lifecycle-fixture"))
            .args(["--fixture-generation", path.to_str().unwrap(), phase])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(parent.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let ready: Value = serde_json::from_str(&line).unwrap();
        let child: Option<ProcessIdentity> =
            serde_json::from_value(ready["child"].clone()).unwrap();
        let old_nonce = load(&path).unwrap().nonce;
        parent.kill().unwrap();
        parent.wait().unwrap();
        if phase == "spawning" {
            assert!(recovery::begin(path.clone(), 0, &mut NativeProcessTable).is_err());
            stop_fixture(child.as_ref().unwrap());
            assert!(recovery::begin(path.clone(), 0, &mut NativeProcessTable).is_err());
            assert_eq!(load(&path).unwrap().nonce, old_nonce);
            continue;
        }
        let (tx, rx) = mpsc::channel();
        let owned = path.clone();
        std::thread::spawn(move || {
            let _ = tx.send(recovery::begin(owned, 0, &mut NativeProcessTable));
        });
        if let Some(child) = child {
            assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
            assert_eq!(load(&path).unwrap().nonce, old_nonce);
            stop_fixture(&child);
        }
        let resources = rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        assert_ne!(resources.guard.record().nonce, old_nonce);
        assert!(resources.guard.record().children.is_empty());
        resources
            .guard
            .finish_recovery(json!({"previousOutcome":"no-write-started","observedDeviceId":null}))
            .unwrap();
    }
}
#[test]
fn pre_adoption_owner_claim_requires_r1_actual_exit_while_guard_still_names_p0() {
    let path = directory().join("session.json");
    let guard = SessionGuard::create_at(path.clone()).unwrap();
    let mut old = serde_json::to_value(guard.record()).unwrap();
    drop(guard);
    old["parent"] = json!({"pid":u32::MAX,"creationTime":1});
    std::fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
    let r0 = format!(
        "{}\n",
        json!({"owner":{"pid":u32::MAX-1,"creationTime":1},"nonce":"b".repeat(64)})
    );
    std::fs::write(razer_hid_helper::recovery_owner::claim_path(&path), &r0).unwrap();
    let mut r1 = Command::new(env!("CARGO_BIN_EXE_lifecycle-fixture"))
        .args(["--fixture-recovery-owner", path.to_str().unwrap()])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(r1.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    assert!(
        std::fs::read(razer_hid_helper::recovery_owner::claim_path(&path))
            .unwrap()
            .starts_with(r0.as_bytes())
    );
    assert_eq!(load(&path).unwrap().parent.pid, u32::MAX);
    let (tx, rx) = mpsc::channel();
    let owned = path.clone();
    std::thread::spawn(move || {
        let _ = tx.send(recovery::begin(owned, 0, &mut NativeProcessTable));
    });
    let early = rx.recv_timeout(Duration::from_millis(100));
    let chain = std::fs::read(razer_hid_helper::recovery_owner::claim_path(&path)).unwrap();
    assert_eq!(
        chain.iter().filter(|byte| **byte == b'\n').count(),
        3,
        "R2 is recorded before waiting for prior R1"
    );
    r1.kill().unwrap();
    r1.wait().unwrap();
    assert!(
        early.is_err(),
        "R2 must wait R1 even though its recovery lock is released and guard still names P0"
    );
    let resources = rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
    assert!(resources
        .guard
        .record()
        .audit
        .iter()
        .any(|row| row["recoveryOwner"] == ready["parent"] && row["waited"] == true));
    assert!(!razer_hid_helper::recovery_owner::claim_path(&path).exists());
    resources
        .guard
        .finish_recovery(json!({"previousOutcome":"no-write-started","observedDeviceId":null}))
        .unwrap();
}
