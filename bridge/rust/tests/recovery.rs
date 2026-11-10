use razer_hid_helper::{
    process::{Observation, ProcessIdentity, ProcessTable},
    recovery::{audit_generation, read_plan, ReadPlan},
    session_guard::{load, SessionGuard, WriteRisk},
    socket::ExclusiveSocket,
};
use serde_json::{json, Value};
use std::{io, path::PathBuf};
fn directory() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "razer-recovery-{}-{}",
        std::process::id(),
        razer_hid_helper::process::nonce().unwrap()
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}
struct Table {
    observation: Observation,
    waits: usize,
    denied: bool,
}
impl ProcessTable for Table {
    fn observe(&mut self, _: &ProcessIdentity) -> io::Result<Observation> {
        if self.denied {
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied"))
        } else {
            Ok(self.observation.clone())
        }
    }
    fn wait(&mut self, _: &ProcessIdentity) -> io::Result<()> {
        self.waits += 1;
        Ok(())
    }
}
#[test]
fn recovery_process_table_waits_only_matching_active_and_denial_preserves_guard() {
    let dir = directory();
    let guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    for observation in [
        Observation::Active,
        Observation::Signaled,
        Observation::Gone,
        Observation::Reused,
    ] {
        let mut table = Table {
            observation: observation.clone(),
            waits: 0,
            denied: false,
        };
        let (_, evidence) = audit_generation(guard.path(), &mut table).unwrap();
        assert_eq!(table.waits, usize::from(observation == Observation::Active));
        assert!(!evidence.is_empty());
    }
    assert!(audit_generation(
        guard.path(),
        &mut Table {
            observation: Observation::Gone,
            waits: 0,
            denied: true
        }
    )
    .is_err());
    assert!(guard.path().exists());
    guard.finish().unwrap();
}
#[test]
fn risk_and_pinned_target_choose_only_safe_recovery_branch() {
    let dir = directory();
    let mut guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    assert_eq!(
        read_plan(guard.record(), None, false).unwrap(),
        ReadPlan::NoWrite
    );
    let child = ProcessIdentity {
        pid: 777,
        creation_time: 77,
    };
    guard
        .register(child.clone(), Some(&"a".repeat(24)))
        .unwrap();
    guard.retire(&child).unwrap();
    assert_eq!(guard.record().write_risk, WriteRisk::MayHaveWritten);
    assert_eq!(
        read_plan(guard.record(), None, false).unwrap(),
        ReadPlan::Target("a".repeat(24))
    );
    assert!(read_plan(guard.record(), Some(&"b".repeat(24)), false).is_err());
    let mut old = serde_json::to_value(guard.record()).unwrap();
    old.as_object_mut().unwrap().remove("writeRisk");
    old["affectedDeviceId"] = json!(null);
    std::fs::write(guard.path(), serde_json::to_vec(&old).unwrap()).unwrap();
    let record = load(guard.path()).unwrap();
    assert!(read_plan(&record, None, false).is_err());
    assert_eq!(
        read_plan(&record, None, true).unwrap(),
        ReadPlan::UnknownAcknowledgement
    );
}
#[test]
fn exclusive_reservation_blocks_all_other_modes_without_listening() {
    let socket = ExclusiveSocket::reserve(0).unwrap();
    let port = socket.port().unwrap();
    assert!(ExclusiveSocket::reserve(port).is_err());
    assert!(std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        std::time::Duration::from_millis(100)
    )
    .is_err());
}
#[test]
fn uncertain_write_cannot_be_erased_by_clean_finish() {
    let dir = directory();
    let path = dir.join("session.json");
    let mut guard = SessionGuard::create_at(path.clone()).unwrap();
    let child = ProcessIdentity {
        pid: 777,
        creation_time: 77,
    };
    guard
        .register(child.clone(), Some(&"a".repeat(24)))
        .unwrap();
    guard.retire(&child).unwrap();
    assert!(
        guard.finish().is_err(),
        "unknown write outcome must survive normal clean shutdown"
    );
    assert_eq!(
        load(&path).unwrap().affected_device_id,
        Some("a".repeat(24))
    );
}
#[test]
fn unregistered_spawn_window_is_not_proof_of_no_live_worker() {
    let dir = directory();
    let guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let mut record = serde_json::to_value(guard.record()).unwrap();
    record["phase"] = json!("spawning");
    std::fs::write(guard.path(), serde_json::to_vec(&record).unwrap()).unwrap();
    let mut table = Table {
        observation: Observation::Gone,
        waits: 0,
        denied: false,
    };
    assert!(
        audit_generation(guard.path(), &mut table).is_err(),
        "unknown child identity cannot be cleared by no-write risk or acknowledgement"
    );
    assert!(guard.path().exists());
}
#[test]
fn unknown_phase_metadata_is_never_a_safe_recovery_generation() {
    let dir = directory();
    let guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let mut record = serde_json::to_value(guard.record()).unwrap();
    record["phase"] = json!("spawing");
    std::fs::write(guard.path(), serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(
        load(guard.path()).is_err(),
        "a phase typo must not bypass the spawning barrier"
    );
}
#[test]
fn acknowledgement_cannot_treat_another_connected_identity_as_absent_target() {
    use razer_hid_helper::recovery::outcome;
    let dir = directory();
    let guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let mut record = guard.record().clone();
    record.write_risk = WriteRisk::MayHaveWritten;
    record.affected_device_id = Some("a".repeat(24));
    let wrong = json!({"selectedDeviceId":"b".repeat(24),"connected":true});
    assert!(
        outcome(
            &record,
            &ReadPlan::Target("a".repeat(24)),
            true,
            Some(&wrong)
        )
        .is_err(),
        "a read of B cannot establish A is unavailable"
    );
    guard.finish().unwrap();
}
#[test]
fn missing_old_risk_does_not_trust_an_unqualified_affected_id() {
    let dir = directory();
    let guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let mut record = serde_json::to_value(guard.record()).unwrap();
    record.as_object_mut().unwrap().remove("writeRisk");
    record["affectedDeviceId"] = json!("a".repeat(24));
    std::fs::write(guard.path(), serde_json::to_vec(&record).unwrap()).unwrap();
    let loaded = load(guard.path()).unwrap();
    assert_eq!(loaded.write_risk, WriteRisk::MayHaveWritten);
    assert_eq!(
        loaded.affected_device_id, None,
        "old metadata lacking writeRisk cannot establish a trustworthy affected target"
    );
}
#[test]
fn contradictory_or_untyped_previous_outcomes_refuse_before_recovery_work() {
    for previous in [
        json!({"status":"unknown","deviceId":"a".repeat(24)}),
        json!({"status":"confirmed"}),
        json!({"status":"unknown","deviceId":"bad"}),
        json!({"status":"unexpected"}),
    ] {
        let dir = directory();
        let guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
        let path = guard.path().to_owned();
        let mut record = serde_json::to_value(guard.record()).unwrap();
        record["previousOutcome"] = previous;
        let bytes = serde_json::to_vec(&record).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        assert!(
            load(&path).is_err(),
            "contradictory outcome must not enter no-write recovery"
        );
        assert!(audit_generation(
            &path,
            &mut Table {
                observation: Observation::Gone,
                waits: 0,
                denied: false
            }
        )
        .is_err());
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    let dir = directory();
    let guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let mut record = guard.record().clone();
    record.phase = "worker-pending".into();
    record.children = vec![record.parent.clone()];
    assert!(
        record.validate().is_err(),
        "a parent cannot be its own child"
    );
    guard.finish().unwrap();
}
#[test]
fn failed_targeted_read_cannot_be_acknowledged_as_unavailable() {
    use razer_hid_helper::{recovery::outcome, ApiError};
    let dir = directory();
    let guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let path = guard.path().to_owned();
    let mut record = guard.record().clone();
    record.write_risk = WriteRisk::MayHaveWritten;
    record.affected_device_id = Some("a".repeat(24));
    let failed: Result<Value, ApiError> = Err(ApiError::new(504, "inventory timed out"));
    assert!(
        outcome(
            &record,
            &ReadPlan::Target("a".repeat(24)),
            true,
            failed.as_ref().ok()
        )
        .is_err(),
        "indeterminate read is not evidence that A is unavailable"
    );
    assert!(path.exists());
    guard.finish().unwrap();
}
#[test]
fn incomplete_recovery_owner_claim_refuses_before_adoption() {
    use razer_hid_helper::recovery::begin;
    let dir = directory();
    let path = dir.join("session.json");
    let guard = SessionGuard::create_at(path.clone()).unwrap();
    let before = std::fs::read(&path).unwrap();
    std::fs::write(path.with_extension("recovery-owner.json"), b"{").unwrap();
    assert!(
        begin(
            path.clone(),
            0,
            &mut Table {
                observation: Observation::Gone,
                waits: 0,
                denied: false
            }
        )
        .is_err(),
        "an incomplete owner claim must not permit adoption under old parent P0"
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    drop(guard);
}
#[test]
fn legacy_may_have_written_without_outcome_cannot_use_normal_clean_finish() {
    let dir = directory();
    let path = dir.join("session.json");
    let original = SessionGuard::create_at(path.clone()).unwrap();
    let mut record = original.record().clone();
    drop(original);
    record.write_risk = WriteRisk::MayHaveWritten;
    record.previous_outcome = None;
    record.affected_device_id = None;
    let adopted = SessionGuard::adopt(path.clone(), record, vec![]).unwrap();
    assert!(
        adopted.finish().is_err(),
        "missing historical confirmation remains unresolved until explicit recovery receipt"
    );
    assert!(path.exists());
}
#[test]
fn owner_claim_appends_current_before_auditing_prior_records_without_replacing_them() {
    use razer_hid_helper::recovery_owner::{claim_path, RecoveryOwner};
    let dir = directory();
    let path = dir.join("session.json");
    let guard = SessionGuard::create_at(path.clone()).unwrap();
    let previous = format!(
        "{}\n",
        json!({"owner":{"pid":u32::MAX,"creationTime":1},"nonce":"a".repeat(64)})
    );
    std::fs::write(claim_path(&path), &previous).unwrap();
    let (_owner, _) = RecoveryOwner::claim(
        &path,
        &mut Table {
            observation: Observation::Gone,
            waits: 0,
            denied: false,
        },
    )
    .unwrap();
    let bytes = std::fs::read(claim_path(&path)).unwrap();
    assert!(
        bytes.starts_with(previous.as_bytes()),
        "prior owner records must remain while current owner is durably appended"
    );
    assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 2);
    drop(guard);
}
#[test]
fn missing_or_invalid_main_guard_does_not_create_a_recovery_owner_claim() {
    use razer_hid_helper::{recovery::begin, recovery_owner::claim_path};
    let dir = directory();
    let path = dir.join("session.json");
    for invalid in [false, true] {
        if invalid {
            std::fs::write(&path, b"{").unwrap();
        }
        assert!(begin(
            path.clone(),
            0,
            &mut Table {
                observation: Observation::Gone,
                waits: 0,
                denied: false
            }
        )
        .is_err());
        assert!(!claim_path(&path).exists());
    }
}
#[test]
fn busy_ports_keep_prior_guard_bytes_in_normal_recovery_and_ack_paths() {
    use razer_hid_helper::recovery::{begin, normal_session};
    let dir = directory();
    let path = dir.join("session.json");
    let socket = ExclusiveSocket::reserve(0).unwrap();
    let port = socket.port().unwrap();
    assert!(normal_session(path.clone(), port).is_err());
    assert!(
        !path.exists(),
        "only the new childless normal guard may be removed after bind failure"
    );
    let guard = SessionGuard::create_at(path.clone()).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert!(normal_session(path.clone(), port).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    for _mode in ["recovery", "acknowledgement"] {
        assert!(begin(
            path.clone(),
            port,
            &mut Table {
                observation: Observation::Gone,
                waits: 0,
                denied: false
            }
        )
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
    guard.finish().unwrap();
}
#[test]
fn receipts_fail_closed_and_recovery_outcomes_are_observation_only() {
    use razer_hid_helper::recovery::outcome;
    let dir = directory();
    let guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let path = guard.path().to_owned();
    let observed = outcome(guard.record(), &ReadPlan::NoWrite, false, None).unwrap();
    assert_eq!(
        observed,
        json!({"previousOutcome":"no-write-started","observedDeviceId":null})
    );
    guard.receipt(observed.clone()).unwrap();
    assert!(guard.finish_recovery(observed).is_err());
    assert!(path.exists(), "failed durable receipt must keep guard");
    let record = load(&path).unwrap();
    let target = "a".repeat(24);
    let mut record = record;
    record.write_risk = WriteRisk::MayHaveWritten;
    record.affected_device_id = Some(target.clone());
    let plan = ReadPlan::Target(target.clone());
    let absent = json!({"selectedDeviceId":target,"connected":false});
    let present = json!({"selectedDeviceId":target,"connected":true});
    assert!(outcome(&record, &plan, false, Some(&absent)).is_err());
    assert!(outcome(&record, &plan, true, Some(&present)).is_err());
    assert_eq!(
        outcome(&record, &plan, false, Some(&present)).unwrap()["previousOutcome"],
        "unknown"
    );
    let ack = outcome(&record, &plan, true, Some(&absent)).unwrap();
    assert_eq!(ack["previousOutcome"], "unresolved");
    assert_eq!(ack["observedDeviceId"], Value::Null);
    assert!(ack.get("verified").is_none());
}
#[test]
fn parent_wait_reloads_the_last_child_registration_before_adoption() {
    struct RegisterDuringWait {
        path: PathBuf,
        parent: ProcessIdentity,
        child: ProcessIdentity,
        seen: Vec<u32>,
    }
    impl ProcessTable for RegisterDuringWait {
        fn observe(&mut self, p: &ProcessIdentity) -> io::Result<Observation> {
            self.seen.push(p.pid);
            Ok(if p == &self.parent {
                Observation::Active
            } else {
                Observation::Gone
            })
        }
        fn wait(&mut self, _: &ProcessIdentity) -> io::Result<()> {
            let mut value = serde_json::to_value(load(&self.path)?).unwrap();
            value["phase"] = json!("worker-pending");
            value["children"] = json!([self.child]);
            std::fs::write(&self.path, serde_json::to_vec(&value).unwrap())
        }
    }
    let dir = directory();
    let guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let mut table = RegisterDuringWait {
        path: guard.path().into(),
        parent: guard.record().parent.clone(),
        child: ProcessIdentity {
            pid: 777,
            creation_time: 77,
        },
        seen: vec![],
    };
    let (record, evidence) = audit_generation(guard.path(), &mut table).unwrap();
    assert_eq!(record.children, [table.child.clone()]);
    assert_eq!(table.seen, [table.parent.pid, 777]);
    assert_eq!(evidence.len(), 2);
}
