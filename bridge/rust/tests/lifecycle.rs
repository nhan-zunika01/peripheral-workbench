use razer_hid_helper::inventory::Device;
use razer_hid_helper::{
    session_guard::SessionGuard,
    worker::{WorkerRequest, WorkerRunner},
};
use std::{path::PathBuf, time::Duration};

fn directory() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "razer-lifecycle-{}-{}",
        std::process::id(),
        razer_hid_helper::process::nonce().unwrap()
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}
fn request(mode: &str) -> WorkerRequest {
    WorkerRequest::Inspect {
        target: Device {
            id: "a".repeat(24),
            name: mode.into(),
            container_id: None,
            interfaces: vec![],
            endpoints: vec![],
            supported: true,
            reason: None,
        },
        tickets: vec![],
        change: None,
        allow_writes: false,
    }
}
fn runner() -> WorkerRunner {
    WorkerRunner::new(
        PathBuf::from(env!("CARGO_BIN_EXE_lifecycle-fixture")),
        false,
    )
    .with_deadlines(Duration::from_secs(5), Duration::from_secs(5))
}
#[test]
fn timeout_kills_waits_and_retires_before_returning() {
    let dir = directory();
    let mut guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let result = runner().run(&request("hang"), &mut guard, || Ok(()));
    assert_eq!(result.unwrap_err().status, 504);
    assert!(
        guard.record().children.is_empty(),
        "a returned runner owns no unreaped child"
    );
    guard.finish().unwrap();
    assert!(!dir.join("session.json").exists());
}
#[test]
fn one_response_is_bounded_and_late_or_extra_success_is_rejected() {
    for mode in ["late-success", "excess-output", "extra-frame", "crash"] {
        let dir = directory();
        let mut guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
        assert!(
            runner().run(&request(mode), &mut guard, || Ok(())).is_err(),
            "{mode}"
        );
        assert!(guard.record().children.is_empty());
        guard.finish().unwrap();
    }
}
#[test]
fn before_go_rejection_never_runs_fixture_side_effect() {
    let dir = directory();
    let mut guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let error = runner()
        .run(&request("success"), &mut guard, || {
            Err(razer_hid_helper::ApiError::new(409, "epoch changed"))
        })
        .unwrap_err();
    assert_eq!(error.status, 409);
    assert!(guard.record().children.is_empty());
    guard.finish().unwrap();
}
#[test]
fn nested_duplicate_private_response_fields_are_rejected() {
    let dir = directory();
    let mut guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let error = runner()
        .run(&request("duplicate-result"), &mut guard, || Ok(()))
        .unwrap_err();
    assert_eq!(error.status, 502);
    assert_eq!(error.error, "Invalid private worker response");
    guard.finish().unwrap();
}
#[test]
fn valid_private_response_is_delivered_after_process_exit() {
    let dir = directory();
    let mut guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let result = runner().run(&request("success"), &mut guard, || Ok(()));
    assert_eq!(result.unwrap()["fixture"], true);
    guard.finish().unwrap();
}
#[test]
fn parent_request_and_argv_permissions_intersect_before_any_worker_write() {
    use razer_hid_helper::{Change, ExpectedValue, JsValue};
    let dir = directory();
    let mut guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let mut forged = request("success");
    if let WorkerRequest::Inspect { allow_writes, .. } = &mut forged {
        *allow_writes = true;
    }
    let result = runner().run(&forged, &mut guard, || Ok(())).unwrap();
    assert_eq!(result["requestedWrites"], false);
    assert_eq!(
        result["argv"],
        serde_json::json!(["--internal-worker", "--read-only"])
    );
    if let WorkerRequest::Inspect { change, .. } = &mut forged {
        *change = Some(Change {
            device_id: "a".repeat(24),
            id: "sleep".into(),
            value: JsValue::Number(120.),
            expected_value: ExpectedValue::Missing,
        });
    }
    assert_eq!(
        runner()
            .run(&forged, &mut guard, || Ok(()))
            .unwrap_err()
            .status,
        400
    );
    assert_eq!(
        razer_hid_helper::worker_native::execute(forged, false, None)
            .unwrap_err()
            .status,
        403
    );
    assert!(guard.record().children.is_empty());
    guard.finish().unwrap();
}
#[test]
fn partial_write_timeout_is_once_and_preserves_unknown_target_without_retry() {
    use razer_hid_helper::{Change, ExpectedValue, JsValue};
    let dir = directory();
    let marker = dir.join("writes");
    let mut guard = SessionGuard::create_with_mode(dir.join("session.json"), true).unwrap();
    let mut partial = request("partial-hang");
    if let WorkerRequest::Inspect {
        target,
        change,
        allow_writes,
        ..
    } = &mut partial
    {
        target.reason = Some(marker.to_string_lossy().into_owned());
        *allow_writes = true;
        *change = Some(Change {
            device_id: target.id.clone(),
            id: "sleep".into(),
            value: JsValue::Number(120.),
            expected_value: ExpectedValue::Missing,
        });
    }
    let runner = WorkerRunner::new(PathBuf::from(env!("CARGO_BIN_EXE_lifecycle-fixture")), true)
        .with_deadlines(Duration::from_secs(5), Duration::from_secs(5));
    assert_eq!(
        runner
            .run(&partial, &mut guard, || Ok(()))
            .unwrap_err()
            .status,
        504
    );
    assert_eq!(std::fs::read(marker).unwrap(), b"1");
    assert!(guard.record().children.is_empty());
    assert!(guard.unresolved());
    assert_eq!(guard.record().affected_device_id, Some("a".repeat(24)));
    assert!(guard.finish().is_err());
}
#[test]
fn eof_before_go_and_extra_input_never_reach_dispatch() {
    use razer_hid_helper::worker::{receive_request, write_frame, INPUT_LIMIT};
    let bytes = serde_json::to_vec(&WorkerRequest::Inventory).unwrap();
    let mut frame = vec![];
    write_frame(&mut frame, &bytes, INPUT_LIMIT).unwrap();
    assert!(receive_request(&mut frame.as_slice()).is_err());
    frame.extend(b"GO\nextra");
    assert!(receive_request(&mut frame.as_slice()).is_err());
    assert!(receive_request(&mut ((INPUT_LIMIT + 1) as u32).to_le_bytes().as_slice()).is_err());
}
#[test]
fn expired_budget_takes_precedence_over_an_already_signaled_child() {
    use razer_hid_helper::process::{NativeProcessTable, ProcessTable};
    let dir = directory();
    let exe = dir.join("exit-before-go.exe");
    std::fs::copy(env!("CARGO_BIN_EXE_lifecycle-fixture"), &exe).unwrap();
    let path = dir.join("session.json");
    let mut guard = SessionGuard::create_at(path.clone()).unwrap();
    let runner = WorkerRunner::new(exe, false)
        .with_deadlines(Duration::from_millis(50), Duration::from_millis(50));
    let error = runner
        .run(&request("success"), &mut guard, || {
            let record = razer_hid_helper::session_guard::load(&path).unwrap();
            NativeProcessTable.wait(&record.children[0]).unwrap();
            Ok(())
        })
        .unwrap_err();
    assert_eq!(
        error.status, 504,
        "an exited child cannot turn an expired budget into a different result"
    );
    guard.finish().unwrap();
}
#[test]
fn failed_job_assignment_waits_fixture_exit_without_go_or_side_effects() {
    use razer_hid_helper::process::{NativeProcessTable, Observation, ProcessTable};
    let dir = directory();
    let mut guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let mut identity = None;
    let error = runner()
        .run_with_job_factory(
            &request("success"),
            &mut guard,
            || panic!("GO after failed Job assignment"),
            |child| {
                identity = Some(razer_hid_helper::process::child_identity(child).unwrap());
                Err(std::io::Error::other("fixture Job assignment denied"))
            },
        )
        .unwrap_err();
    assert_eq!(error.status, 502);
    assert!(matches!(
        NativeProcessTable.observe(&identity.unwrap()).unwrap(),
        Observation::Signaled | Observation::Gone
    ));
    assert_eq!(guard.record().phase, "idle");
    assert!(guard.record().children.is_empty());
    guard.finish().unwrap();
}
#[test]
fn final_dispatch_check_runs_only_after_the_request_frame_is_prepared() {
    let dir = directory();
    let marker = dir.join("frame-prepared");
    let mut prepared = request("frame-observer");
    if let WorkerRequest::Inspect { target, .. } = &mut prepared {
        target.reason = Some(marker.to_string_lossy().into_owned());
    }
    let mut guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let result = runner().run(&prepared, &mut guard, || {
        let until = std::time::Instant::now() + Duration::from_secs(2);
        while !marker.exists() && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(2));
        }
        if marker.exists() {
            Ok(())
        } else {
            Err(razer_hid_helper::ApiError::new(
                409,
                "frame was not prepared before dispatch check",
            ))
        }
    });
    assert_eq!(result.unwrap()["fixture"], true);
    guard.finish().unwrap();
}
#[test]
fn no_input_child_cannot_block_the_timeout_kill_wait_path() {
    let dir = directory();
    let exe = dir.join("no-input.exe");
    std::fs::copy(env!("CARGO_BIN_EXE_lifecycle-fixture"), &exe).unwrap();
    let mut large = request("fixture");
    if let WorkerRequest::Inspect { target, .. } = &mut large {
        target.reason = Some("x".repeat(13_000));
    }
    let mut guard = SessionGuard::create_at(dir.join("session.json")).unwrap();
    let started = std::time::Instant::now();
    let runner = WorkerRunner::new(exe, false)
        .with_deadlines(Duration::from_secs(1), Duration::from_secs(1));
    assert_eq!(
        runner
            .run(&large, &mut guard, || Ok(()))
            .unwrap_err()
            .status,
        504
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(guard.record().children.is_empty());
    guard.finish().unwrap();
}
