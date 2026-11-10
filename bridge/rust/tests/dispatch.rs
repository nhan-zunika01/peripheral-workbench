use razer_hid_helper::inventory::{collect_results, AttachmentGuard, HidNode};
use std::{sync::mpsc, time::Duration};
#[test]
fn notification_and_go_share_one_atomic_decision() {
    let hid: Vec<HidNode> = serde_json::from_value(
        serde_json::json!([{"path":"unit-a","vendorId":5426,"productId":223,"interface":0}]),
    )
    .unwrap();
    let inventory = collect_results(Ok(hid), Ok(vec![]));
    let device = &inventory.devices[0];
    let (mut guard, signal) = AttachmentGuard::new();
    let window = guard.begin_observation();
    guard.observe(&inventory, &device.id, window).unwrap();
    let ticket = guard.prepare(device, "unit-a").unwrap();
    let permit = guard.dispatch_gate().arm();
    guard.check_dispatch(&ticket).unwrap();
    signal.removed("unit-a");
    assert!(!permit.commit(), "removal before CAS must prevent GO");
    let delayed = razer_hid_helper::dispatch::DispatchGate::default();
    delayed.removed();
    assert_eq!(
        delayed.arm_at_epoch(0).err().unwrap().status,
        409,
        "arming from old binding epoch cannot capture a pending callback's newer version"
    );
    let gate = razer_hid_helper::dispatch::DispatchGate::default();
    let permit = gate.arm();

    assert!(permit.commit());
    gate.removed();
    assert!(
        !permit.accept_completion(),
        "postcommit removal makes completion uncertain"
    );
    let permit = gate.arm();

    assert!(permit.commit());
    assert!(permit.accept_completion());
    gate.removed();
}
#[test]
fn a_blocked_go_write_cannot_block_the_removal_callback() {
    use std::sync::{Arc, Condvar, Mutex};
    struct BlockedGo {
        release: Arc<(Mutex<bool>, Condvar)>,
        entered: mpsc::Sender<()>,
    }
    impl std::io::Write for BlockedGo {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            assert_eq!(bytes, b"GO\n");
            self.entered.send(()).unwrap();
            let (lock, cv) = &*self.release;
            let (released, _) = cv
                .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(2), |released| {
                    !*released
                })
                .unwrap();
            assert!(*released);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let (guard, signal) = AttachmentGuard::new();
    let decision = guard.dispatch_gate();
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let owned = release.clone();
    let (entered_tx, entered_rx) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        let permit = decision.arm();
        permit
            .send_go(&mut BlockedGo {
                release: owned,
                entered: entered_tx,
            })
            .unwrap();
    });
    entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let callback = std::thread::spawn(move || {
        signal.removed("unit-a");
        done_tx.send(()).unwrap();
    });
    let before_unblock = done_rx.recv_timeout(Duration::from_millis(50));
    {
        let (lock, cv) = &*release;
        *lock.lock().unwrap() = true;
        cv.notify_one();
    }
    writer.join().unwrap();
    callback.join().unwrap();
    assert!(
        before_unblock.is_ok(),
        "a callback must return while GO transport is blocked"
    );
}
#[test]
fn postcommit_removal_before_verification_acceptance_keeps_write_unknown() {
    use razer_hid_helper::{
        backend::Backend,
        inventory::{Inventory, RemovalSignal},
        physical_backend::PhysicalBackend,
        session_guard::{load, PreviousOutcome, SessionGuard},
        socket::ExclusiveSocket,
        worker::{WorkerExecutor, WorkerRequest},
        ApiError, Change, ExpectedValue, JsValue,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    struct VerifiedAfterRemoval {
        inventory: Inventory,
        signal: RemovalSignal,
        writes: Arc<AtomicUsize>,
    }
    impl WorkerExecutor for VerifiedAfterRemoval {
        fn execute(
            &self,
            request: &WorkerRequest,
            guard: &mut SessionGuard,
            permit: razer_hid_helper::dispatch::DispatchPermit,
            before_go: &mut (dyn FnMut() -> Result<(), ApiError> + Send),
        ) -> Result<serde_json::Value, ApiError> {
            before_go()?;
            assert!(permit.commit());
            if let Some(id) = request.write_target() {
                let child = razer_hid_helper::process::ProcessIdentity {
                    pid: 777,
                    creation_time: 77,
                };
                guard.register(child.clone(), Some(id)).unwrap();
                guard.retire(&child).unwrap();
                self.writes.fetch_add(1, Ordering::SeqCst);
                self.signal.removed("unit-a");
                return Ok(serde_json::json!({"verified":true,"verification":"hardware-readback"}));
            }
            Ok(match request {
                WorkerRequest::Inventory => serde_json::to_value(&self.inventory).unwrap(),
                _ => {
                    serde_json::json!({"connected":true,"settings":[{"id":"sleep","type":"number","value":60,"writable":true}]})
                }
            })
        }
    }
    let hid: Vec<HidNode> = serde_json::from_value(
        serde_json::json!([{"path":"unit-a","vendorId":5426,"productId":223,"interface":0}]),
    )
    .unwrap();
    let inventory = collect_results(Ok(hid), Ok(vec![]));
    let id = inventory.devices[0].id.clone();
    let (attachment, signal) = AttachmentGuard::new();
    let writes = Arc::new(AtomicUsize::new(0));
    let path = std::env::temp_dir().join(format!(
        "razer-postcommit-{}.json",
        razer_hid_helper::process::nonce().unwrap()
    ));
    let guard = SessionGuard::create_with_mode(path.clone(), true).unwrap();
    let mut backend = PhysicalBackend::from_parts(
        VerifiedAfterRemoval {
            inventory,
            signal,
            writes: writes.clone(),
        },
        attachment,
        guard,
        true,
        (),
        Arc::new(ExclusiveSocket::reserve(0).unwrap()),
    );
    backend.snapshot(Some(&id)).unwrap();
    let result = backend.apply(&Change {
        device_id: id.clone(),
        id: "sleep".into(),
        value: JsValue::Number(120.),
        expected_value: ExpectedValue::Missing,
    });
    assert_eq!(
        result.unwrap_err().status,
        502,
        "verified child bytes cannot confirm an attachment that changed after dispatch"
    );
    assert_eq!(
        load(&path).unwrap().previous_outcome,
        Some(PreviousOutcome::Unknown { device_id: id })
    );
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    assert!(backend.shutdown().is_err());
}
#[test]
fn paused_callback_after_gate_increment_before_epoch_increment_sends_zero_go() {
    use razer_hid_helper::{
        backend::Backend,
        physical_backend::PhysicalBackend,
        session_guard::SessionGuard,
        socket::ExclusiveSocket,
        worker::{WorkerExecutor, WorkerRequest},
        ApiError, Change, ExpectedValue, JsValue,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    struct Paused {
        inventory: razer_hid_helper::inventory::Inventory,
        writes: Arc<AtomicUsize>,
        gate: razer_hid_helper::dispatch::DispatchGate,
    }
    impl WorkerExecutor for Paused {
        fn execute(
            &self,
            request: &WorkerRequest,
            _: &mut SessionGuard,
            permit: razer_hid_helper::dispatch::DispatchPermit,
            check: &mut (dyn FnMut() -> Result<(), ApiError> + Send),
        ) -> Result<serde_json::Value, ApiError> {
            if request.write_target().is_some() {
                self.gate.removed();
            } // callback's epoch/event delivery deliberately remains pending
            check()?;
            permit.send_go(&mut vec![])?;
            if request.write_target().is_some() {
                self.writes.fetch_add(1, Ordering::SeqCst);
                return Ok(serde_json::json!({"verified":true}));
            }
            Ok(match request {
                WorkerRequest::Inventory => serde_json::to_value(&self.inventory).unwrap(),
                _ => {
                    serde_json::json!({"connected":true,"settings":[{"id":"sleep","type":"number","value":60,"writable":true}]})
                }
            })
        }
    }
    let hid: Vec<HidNode> = serde_json::from_value(
        serde_json::json!([{"path":"unit-a","vendorId":5426,"productId":223,"interface":0}]),
    )
    .unwrap();
    let inventory = collect_results(Ok(hid), Ok(vec![]));
    let id = inventory.devices[0].id.clone();
    let (attachment, _) = AttachmentGuard::new();
    let writes = Arc::new(AtomicUsize::new(0));
    let path = std::env::temp_dir().join(format!(
        "razer-paused-removal-{}.json",
        razer_hid_helper::process::nonce().unwrap()
    ));
    let guard = SessionGuard::create_with_mode(path, true).unwrap();
    let gate = attachment.dispatch_gate();
    let mut backend = PhysicalBackend::from_parts(
        Paused {
            inventory,
            writes: writes.clone(),
            gate,
        },
        attachment,
        guard,
        true,
        (),
        Arc::new(ExclusiveSocket::reserve(0).unwrap()),
    );
    backend.snapshot(Some(&id)).unwrap();
    let result = backend.apply(&Change {
        device_id: id,
        id: "sleep".into(),
        value: JsValue::Number(120.),
        expected_value: ExpectedValue::Missing,
    });
    assert_eq!(
        writes.load(Ordering::SeqCst),
        0,
        "precommit removal cannot be captured by a fresh inner permit"
    );
    assert_eq!(result.unwrap_err().status, 409);
    backend.shutdown().unwrap();
}
