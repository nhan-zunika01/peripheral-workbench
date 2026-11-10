use razer_hid_helper::{
    backend::{transact, Backend},
    coordinator::Coordinator,
    ApiError, Change, ExpectedValue, JsValue,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
struct Fake {
    reads: Arc<AtomicUsize>,
    writes: Arc<AtomicUsize>,
    refresh_fail: bool,
}
const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaa";
fn change() -> Change {
    Change {
        device_id: A.into(),
        id: "sleep".into(),
        value: JsValue::Number(120.),
        expected_value: ExpectedValue::Present(JsValue::Number(60.)),
    }
}
impl Backend for Fake {
    fn snapshot(&mut self, _: Option<&str>) -> Result<Value, ApiError> {
        let index = self.reads.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(60));
        if self.refresh_fail && index > 0 {
            return Err(ApiError::new(502, "refresh failed"));
        }
        Ok(
            json!({"selectedDeviceId":A,"connected":true,"settings":[{"id":"sleep","type":"number","writable":true,"value":60,"min":60,"max":900,"integer":true,"step":60}]}),
        )
    }
    fn apply(&mut self, _: &Change) -> Result<Value, ApiError> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"verified":true,"verification":"hardware-readback"}))
    }
}
fn fake(refresh_fail: bool) -> Fake {
    Fake {
        reads: Arc::new(AtomicUsize::new(0)),
        writes: Arc::new(AtomicUsize::new(0)),
        refresh_fail,
    }
}
#[test]
fn confirmed_apply_survives_failed_refresh_and_expected_conflict_dispatches_nothing() {
    let mut backend = fake(true);
    let result = transact(&mut backend, &change()).unwrap();
    assert_eq!(result["verified"], true);
    assert!(result["warning"].is_string());
    assert_eq!(backend.writes.load(Ordering::SeqCst), 1);
    let mut backend = fake(false);
    let mut change = change();
    change.expected_value = ExpectedValue::Present(JsValue::Null);
    let error = transact(&mut backend, &change).unwrap_err();
    assert_eq!(error.status, 409);
    assert_eq!(error.actual_value, Some(json!(60)));
    assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn owned_job_shares_reads_and_rejects_busy_write_even_after_client_drop() {
    let backend = fake(false);
    let reads = backend.reads.clone();
    let writes = backend.writes.clone();
    let coordinator = Coordinator::start(move || Ok(Box::new(backend))).unwrap();
    let first = coordinator.read(Some(A.into())).unwrap();
    let second = coordinator.read(Some(A.into())).unwrap();
    let busy = coordinator.write(change()).unwrap_err();
    assert_eq!(busy.status, 409);
    assert_eq!(busy.error, "A device operation is already in progress");
    drop(first);
    assert_eq!(second.result().await.unwrap()["connected"], true);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    let write = coordinator.write(change()).unwrap();
    drop(write);
    coordinator.shutdown().unwrap();
    assert_eq!(writes.load(Ordering::SeqCst), 1);
}
#[test]
fn confirmed_refresh_identity_change_cannot_publish_b_settings() {
    struct WrongRefresh(Fake);
    impl Backend for WrongRefresh {
        fn snapshot(&mut self, id: Option<&str>) -> Result<Value, ApiError> {
            let mut state = self.0.snapshot(id)?;
            if self.0.reads.load(Ordering::SeqCst) > 1 {
                state["selectedDeviceId"] = "b".repeat(24).into();
                state["settings"] = json!([{"value":"B secret"}]);
            }
            Ok(state)
        }
        fn apply(&mut self, c: &Change) -> Result<Value, ApiError> {
            self.0.apply(c)
        }
    }
    let mut backend = WrongRefresh(fake(false));
    let result = transact(&mut backend, &change()).unwrap();
    assert_eq!(result["verified"], true);
    assert_eq!(result["state"]["selectedDeviceId"], A);
    assert_eq!(result["state"]["settings"], json!([]));
    assert_eq!(result["state"]["connected"], false);
    assert_eq!(backend.0.writes.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn reply_deadline_and_different_id_queue_keep_real_pending_child_owned() {
    use razer_hid_helper::{
        process::{NativeProcessTable, Observation, ProcessTable},
        session_guard::SessionGuard,
        worker::{WorkerRequest, WorkerRunner},
    };
    use std::sync::{mpsc, Condvar, Mutex};
    struct Held {
        runner: WorkerRunner,
        guard: Option<SessionGuard>,
        gate: Arc<(Mutex<bool>, Condvar)>,
        started: mpsc::Sender<razer_hid_helper::process::ProcessIdentity>,
        count: Arc<AtomicUsize>,
    }
    impl Backend for Held {
        fn snapshot(&mut self, _: Option<&str>) -> Result<Value, ApiError> {
            let first = self.count.fetch_add(1, Ordering::SeqCst) == 0;
            let path = self.guard.as_ref().unwrap().path().to_owned();
            self.runner.run(
                &WorkerRequest::Inventory,
                self.guard.as_mut().unwrap(),
                || {
                    if first {
                        self.started
                            .send(
                                razer_hid_helper::session_guard::load(&path)
                                    .unwrap()
                                    .children[0]
                                    .clone(),
                            )
                            .unwrap();
                        let (lock, cv) = &*self.gate;
                        let (ready, _) = cv
                            .wait_timeout_while(
                                lock.lock().unwrap(),
                                std::time::Duration::from_secs(3),
                                |ready| !*ready,
                            )
                            .unwrap();
                        if !*ready {
                            return Err(ApiError::new(504, "fixture wait expired"));
                        }
                    }
                    Ok(())
                },
            )
        }
        fn apply(&mut self, _: &Change) -> Result<Value, ApiError> {
            panic!("busy write dispatched")
        }
        fn shutdown(&mut self) -> Result<(), ApiError> {
            self.guard
                .take()
                .unwrap()
                .finish()
                .map_err(|e| ApiError::new(502, e.to_string()))
        }
    }
    let path = std::env::temp_dir().join(format!(
        "razer-owned-task-{}-{}.json",
        std::process::id(),
        razer_hid_helper::process::nonce().unwrap()
    ));
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let count = Arc::new(AtomicUsize::new(0));
    let (tx, rx) = mpsc::channel();
    let held = Held {
        runner: WorkerRunner::new(env!("CARGO_BIN_EXE_lifecycle-fixture").into(), false),
        guard: Some(SessionGuard::create_at(path).unwrap()),
        gate: gate.clone(),
        started: tx,
        count: count.clone(),
    };
    let coordinator = Coordinator::start(move || Ok(Box::new(held))).unwrap();
    let mut a = coordinator.read(Some(A.into())).unwrap();
    let identity = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert_eq!(
        NativeProcessTable.observe(&identity).unwrap(),
        Observation::Active
    );
    let b = coordinator.read(Some("b".repeat(24))).unwrap();
    let timeout = a
        .with_deadline(std::time::Duration::from_millis(10))
        .await
        .unwrap_err();
    assert_eq!(timeout.status, 504);
    assert_eq!(
        timeout.error,
        "Device operation timed out. Inspect the companion before retrying."
    );
    drop(a);
    assert_eq!(coordinator.write(change()).unwrap_err().status, 409);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    {
        let (lock, cv) = &*gate;
        *lock.lock().unwrap() = true;
        cv.notify_one();
    }
    assert_eq!(b.result().await.unwrap()["fixture"], true);
    coordinator.shutdown().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 2);
    assert!(matches!(
        NativeProcessTable.observe(&identity).unwrap(),
        Observation::Gone | Observation::Signaled
    ));
}
#[test]
fn concurrent_shutdown_callers_wait_for_the_same_backend_drain() {
    use std::sync::{mpsc, Condvar, Mutex};
    struct Drain {
        entered: mpsc::Sender<()>,
        gate: Arc<(Mutex<bool>, Condvar)>,
    }
    impl Backend for Drain {
        fn snapshot(&mut self, _: Option<&str>) -> Result<Value, ApiError> {
            unreachable!()
        }
        fn apply(&mut self, _: &Change) -> Result<Value, ApiError> {
            unreachable!()
        }
        fn shutdown(&mut self) -> Result<(), ApiError> {
            self.entered.send(()).unwrap();
            let (lock, cv) = &*self.gate;
            let (released, _) = cv
                .wait_timeout_while(
                    lock.lock().unwrap(),
                    std::time::Duration::from_secs(3),
                    |released| !*released,
                )
                .unwrap();
            assert!(*released);
            Err(ApiError::new(502, "guard deliberately retained"))
        }
    }
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let (entered_tx, entered_rx) = mpsc::channel();
    let owned = gate.clone();
    let coordinator = Arc::new(
        Coordinator::start(move || {
            Ok(Box::new(Drain {
                entered: entered_tx,
                gate: owned,
            }))
        })
        .unwrap(),
    );
    let first = coordinator.clone();
    let first = std::thread::spawn(move || first.shutdown());
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    let second = coordinator.clone();
    let (done_tx, done_rx) = mpsc::channel();
    let second = std::thread::spawn(move || {
        done_tx.send(second.shutdown()).unwrap();
    });
    let early = done_rx.recv_timeout(std::time::Duration::from_millis(50));
    {
        let (lock, cv) = &*gate;
        *lock.lock().unwrap() = true;
        cv.notify_one();
    }
    let first = first.join().unwrap();
    second.join().unwrap();
    assert!(
        early.is_err(),
        "another shutdown caller must not report clean completion before drain finishes"
    );
    assert_eq!(done_rx.recv().unwrap().unwrap_err(), first.unwrap_err());
}
