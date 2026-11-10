fn authorize(
    record: &razer_hid_helper::session_guard::GuardRecord,
    context: &razer_hid_helper::worker_session::WorkerContext,
    child: &razer_hid_helper::process::ProcessIdentity,
    parent: &razer_hid_helper::process::ProcessIdentity,
    active: bool,
    request: &WorkerRequest,
    argv: bool,
) -> Result<bool, razer_hid_helper::ApiError> {
    let image = std::path::Path::new("fixture-companion.exe");
    razer_hid_helper::worker_session::authorize(
        record,
        context,
        child,
        parent,
        active,
        request,
        argv,
        &razer_hid_helper::worker_session::WorkerAuthority {
            expected_guard: &context.guard_path,
            parent_image: image,
            companion_image: image,
        },
    )
}
use razer_hid_helper::{inventory::Device, worker::WorkerRequest};

#[test]
fn direct_worker_entry_requires_registered_parent_context_before_adapter_dispatch() {
    // Empty supported interfaces reach the adapter's no-target branch without touching Windows/HID.
    let request = WorkerRequest::Inspect {
        target: Device {
            id: "a".repeat(24),
            name: "fixture".into(),
            container_id: None,
            interfaces: vec![],
            endpoints: vec![],
            supported: true,
            reason: None,
        },
        tickets: vec![],
        change: None,
        allow_writes: true,
    };
    let error = razer_hid_helper::worker_native::execute(request, true, None).unwrap_err();
    assert_eq!(
        error.status, 403,
        "direct internal mode must require registered live parent context before dispatch"
    );
}
#[test]
fn guard_parent_request_and_argv_modes_intersect_at_fake_dispatch_boundary() {
    use razer_hid_helper::{
        process::ProcessIdentity,
        session_guard::{PreviousOutcome, SessionGuard, WriteRisk},
        worker_session::WorkerContext,
        Change, ExpectedValue, JsValue,
    };
    let path = std::env::temp_dir().join(format!(
        "razer-worker-authorize-{}.json",
        razer_hid_helper::process::nonce().unwrap()
    ));
    let guard = SessionGuard::create_at(path.clone()).unwrap();
    let child = ProcessIdentity {
        pid: 777,
        creation_time: 77,
    };
    let mut record = guard.record().clone();
    record.children = vec![child.clone()];
    record.phase = "worker-pending".into();
    let context = WorkerContext {
        nonce: record.nonce.clone(),
        parent_handle: 123,
        guard_path: path,
    };
    for parent_mode in [false, true] {
        for request_mode in [false, true] {
            for argv_mode in [false, true] {
                record.parent_allow_writes = parent_mode;
                record.write_risk = WriteRisk::MayHaveWritten;
                record.affected_device_id = Some("a".repeat(24));
                record.previous_outcome = Some(PreviousOutcome::Unknown {
                    device_id: "a".repeat(24),
                });
                let request = WorkerRequest::Inspect {
                    target: Device {
                        id: "a".repeat(24),
                        name: "fixture".into(),
                        container_id: None,
                        interfaces: vec![],
                        endpoints: vec![],
                        supported: true,
                        reason: None,
                    },
                    tickets: vec![],
                    change: Some(Change {
                        device_id: "a".repeat(24),
                        id: "sleep".into(),
                        value: JsValue::Number(120.),
                        expected_value: ExpectedValue::Missing,
                    }),
                    allow_writes: request_mode,
                };
                let mut dispatches = 0;
                let result = authorize(
                    &record,
                    &context,
                    &child,
                    &record.parent,
                    true,
                    &request,
                    argv_mode,
                )
                .inspect(|_| {
                    dispatches += 1;
                });
                if parent_mode && request_mode && argv_mode {
                    assert!(result.unwrap());
                    assert_eq!(dispatches, 1);
                } else {
                    assert_eq!(result.unwrap_err().status, 400);
                    assert_eq!(dispatches, 0);
                }
                for (self_id, parent, active, nonce) in [
                    (
                        ProcessIdentity {
                            pid: 778,
                            creation_time: 78,
                        },
                        record.parent.clone(),
                        true,
                        record.nonce.clone(),
                    ),
                    (
                        child.clone(),
                        ProcessIdentity {
                            pid: record.parent.pid,
                            creation_time: record.parent.creation_time + 1,
                        },
                        true,
                        record.nonce.clone(),
                    ),
                    (
                        child.clone(),
                        record.parent.clone(),
                        false,
                        record.nonce.clone(),
                    ),
                    (child.clone(), record.parent.clone(), true, "0".repeat(64)),
                ] {
                    let mut context = context.clone();
                    context.nonce = nonce;
                    let mut dispatches = 0;
                    assert!(authorize(
                        &record, &context, &self_id, &parent, active, &request, argv_mode
                    )
                    .map(|_| dispatches += 1)
                    .is_err());
                    assert_eq!(dispatches, 0);
                }
            }
        }
    }
    guard.finish().unwrap();
}
#[test]
fn fixture_child_validates_real_transferred_parent_handle_and_registration() {
    use razer_hid_helper::{session_guard::SessionGuard, worker::WorkerRunner};
    for allow in [false, true] {
        let path = std::env::temp_dir().join(format!(
            "razer-worker-parent-handle-{}.json",
            razer_hid_helper::process::nonce().unwrap()
        ));
        let mut guard = SessionGuard::create_with_mode(path, allow).unwrap();
        let request = WorkerRequest::Inspect {
            target: Device {
                id: "a".repeat(24),
                name: "authorized-fixture".into(),
                container_id: None,
                interfaces: vec![],
                endpoints: vec![],
                supported: true,
                reason: None,
            },
            tickets: vec![],
            change: None,
            allow_writes: true,
        };
        let runner = WorkerRunner::new(env!("CARGO_BIN_EXE_lifecycle-fixture").into(), true);
        let result = runner.run(&request, &mut guard, || Ok(())).unwrap();
        assert_eq!(result["authorized"], true);
        assert_eq!(result["allowWrites"], allow);
        guard.finish().unwrap();
    }
}
#[test]
fn a_separate_fabricated_guard_is_not_the_companion_session_authority() {
    use razer_hid_helper::{
        process::ProcessIdentity, session_guard::SessionGuard, worker_session::WorkerContext,
    };
    let path = std::env::temp_dir().join(format!(
        "razer-fabricated-guard-{}.json",
        razer_hid_helper::process::nonce().unwrap()
    ));
    let guard = SessionGuard::create_with_mode(path.clone(), true).unwrap();
    let child = ProcessIdentity {
        pid: 777,
        creation_time: 77,
    };
    let mut record = guard.record().clone();
    record.phase = "worker-pending".into();
    record.children = vec![child.clone()];
    let context = WorkerContext {
        nonce: record.nonce.clone(),
        parent_handle: 123,
        guard_path: path,
    };
    let mut dispatches = 0;
    let expected = context.guard_path.with_file_name("canonical-session.json");
    let image = std::path::Path::new("companion.exe");
    let authority = razer_hid_helper::worker_session::WorkerAuthority {
        expected_guard: &expected,
        parent_image: image,
        companion_image: image,
    };
    let result = razer_hid_helper::worker_session::authorize(
        &record,
        &context,
        &child,
        &record.parent,
        true,
        &WorkerRequest::Inventory,
        true,
        &authority,
    )
    .map(|_| dispatches += 1);
    assert_eq!(
        dispatches, 0,
        "a valid-looking unrelated guard must not authorize native inventory or writes"
    );
    assert!(result.is_err());
    let unrelated = std::path::Path::new("unrelated-launcher.exe");
    let authority = razer_hid_helper::worker_session::WorkerAuthority {
        expected_guard: &context.guard_path,
        parent_image: unrelated,
        companion_image: image,
    };
    assert_eq!(
        razer_hid_helper::worker_session::authorize(
            &record,
            &context,
            &child,
            &record.parent,
            true,
            &WorkerRequest::Inventory,
            true,
            &authority
        )
        .unwrap_err()
        .status,
        403
    );
    guard.finish().unwrap();
}
