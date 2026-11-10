use razer_hid_helper::{
    backend::Backend,
    inventory::{collect_results, AttachmentGuard, HidNode, Inventory, RemovalSignal},
    physical_backend::PhysicalBackend,
    session_guard::SessionGuard,
    socket::ExclusiveSocket,
    worker::{WorkerExecutor, WorkerRequest},
    ApiError, Change, ExpectedValue, JsValue,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
struct Script {
    replies: Mutex<VecDeque<Value>>,
    writes: Arc<AtomicUsize>,
    signal: RemovalSignal,
    remove: Arc<AtomicBool>,
    remove_after_check: Arc<AtomicBool>,
}
impl WorkerExecutor for Script {
    fn execute(
        &self,
        request: &WorkerRequest,
        guard: &mut SessionGuard,
        permit: razer_hid_helper::dispatch::DispatchPermit,
        before_go: &mut (dyn FnMut() -> Result<(), ApiError> + Send),
    ) -> Result<Value, ApiError> {
        if matches!(request, WorkerRequest::Inspect { .. })
            && self.remove.swap(false, Ordering::SeqCst)
        {
            self.signal.removed("unit-a");
        }
        // Frame preparation now precedes the serialized final epoch check and GO.
        if request.write_target().is_some() && self.remove_after_check.swap(false, Ordering::SeqCst)
        {
            self.signal.removed("unit-a");
        }

        let permit = if request.write_target().is_some() {
            permit
        } else {
            permit.for_read()
        };
        before_go()?;
        if !permit.commit() {
            return Err(ApiError::new(409, "fixture dispatch epoch changed"));
        }
        if let Some(id) = request.write_target() {
            let child = razer_hid_helper::process::ProcessIdentity {
                pid: 777,
                creation_time: 77,
            };
            guard.register(child.clone(), Some(id)).unwrap();
            guard.retire(&child).unwrap();
            self.writes.fetch_add(1, Ordering::SeqCst);
        }
        let result = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected physical worker");
        if result.get("fixtureError").is_some() {
            Err(ApiError::new(502, "fixture apply failure"))
        } else {
            Ok(result)
        }
    }
}
fn fixture_inventory() -> Inventory {
    let hid: Vec<HidNode> = serde_json::from_value(
        json!([{"path":"unit-a","vendorId":5426,"productId":223,"interface":0}]),
    )
    .unwrap();
    collect_results(Ok(hid), Ok(vec![]))
}
fn snapshot() -> Value {
    json!({"connected":true,"settings":[{"id":"sleep","writable":true,"type":"number","value":60}]})
}
fn make_backend(replies: Vec<Value>) -> (PhysicalBackend<Script, ()>, Arc<AtomicUsize>) {
    let (backend, writes, _) = backend_with_signal(replies);
    (backend, writes)
}
fn backend_with_signal(
    replies: Vec<Value>,
) -> (
    PhysicalBackend<Script, ()>,
    Arc<AtomicUsize>,
    Arc<AtomicBool>,
) {
    let path = std::env::temp_dir().join(format!(
        "razer-physical-{}-{}.json",
        std::process::id(),
        razer_hid_helper::process::nonce().unwrap()
    ));
    let guard = SessionGuard::create_with_mode(path, true).unwrap();
    let (attachment, signal) = AttachmentGuard::new();
    let writes = Arc::new(AtomicUsize::new(0));
    let remove = Arc::new(AtomicBool::new(false));
    let script = Script {
        replies: Mutex::new(replies.into()),
        writes: writes.clone(),
        signal,
        remove: remove.clone(),
        remove_after_check: Arc::new(AtomicBool::new(false)),
    };
    (
        PhysicalBackend::from_parts(
            script,
            attachment,
            guard,
            true,
            (),
            Arc::new(ExclusiveSocket::reserve(0).unwrap()),
        ),
        writes,
        remove,
    )
}
#[test]
fn unknown_sku_never_inspects_and_incomplete_identity_never_writes() {
    let mut unknown = fixture_inventory();
    unknown.devices[0].supported = false;
    unknown.devices[0].reason = Some("unsupported".into());
    let (mut backend, writes) = make_backend(vec![serde_json::to_value(unknown).unwrap()]);
    assert_eq!(backend.snapshot(None).unwrap()["connected"], false);
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    backend.shutdown().unwrap();
    let mut incomplete = fixture_inventory();
    let id = incomplete.devices[0].id.clone();
    incomplete.identity_complete = false;
    let inv = serde_json::to_value(incomplete).unwrap();
    let (mut backend, writes) = make_backend(vec![inv.clone(), snapshot(), inv]);
    assert_eq!(
        backend.snapshot(Some(&id)).unwrap()["settings"][0]["writable"],
        false
    );
    assert_eq!(backend.apply(&change(&id)).unwrap_err().status, 409);
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    backend.shutdown().unwrap();
}
fn change(id: &str) -> Change {
    Change {
        device_id: id.into(),
        id: "sleep".into(),
        value: JsValue::Number(120.),
        expected_value: ExpectedValue::Missing,
    }
}
#[test]
fn removal_at_inspect_projects_readonly_and_removal_at_apply_go_sends_no_write() {
    let inventory = fixture_inventory();
    let id = inventory.devices[0].id.clone();
    let inv = serde_json::to_value(inventory).unwrap();
    let (mut backend, writes, remove) =
        backend_with_signal(vec![inv.clone(), snapshot(), inv.clone(), snapshot(), inv]);
    assert_eq!(
        backend.snapshot(Some(&id)).unwrap()["settings"][0]["writable"],
        true
    );
    remove.store(true, Ordering::SeqCst);
    assert_eq!(
        backend.snapshot(Some(&id)).unwrap()["settings"][0]["writable"],
        false
    );
    assert_eq!(backend.apply(&change(&id)).unwrap_err().status, 409);
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    backend.shutdown().unwrap();
    let inventory = fixture_inventory();
    let inv = serde_json::to_value(inventory).unwrap();
    let (mut backend, writes, remove) = backend_with_signal(vec![inv.clone(), snapshot(), inv]);
    backend.snapshot(Some(&id)).unwrap();
    remove.store(true, Ordering::SeqCst);
    assert_eq!(backend.apply(&change(&id)).unwrap_err().status, 409);
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    backend.shutdown().unwrap();
}
#[test]
fn unknown_apply_latches_session_and_does_not_overwrite_affected_a_with_b() {
    let inventory = fixture_inventory();
    let id = inventory.devices[0].id.clone();
    let inv = serde_json::to_value(inventory).unwrap();
    let (mut backend, writes) = make_backend(vec![
        inv.clone(),
        snapshot(),
        inv,
        json!({"fixtureError":true}),
    ]);
    backend.snapshot(Some(&id)).unwrap();
    assert_eq!(backend.apply(&change(&id)).unwrap_err().status, 502);
    assert_eq!(
        backend.apply(&change(&"b".repeat(24))).unwrap_err().status,
        400
    );
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    assert!(backend.shutdown().is_err());
}
#[test]
fn listener_failure_cleans_new_normal_guard_but_preserves_recovery_guard() {
    for recovering in [false, true] {
        let path = std::env::temp_dir().join(format!(
            "razer-listener-failure-{}.json",
            razer_hid_helper::process::nonce().unwrap()
        ));
        let mut guard = SessionGuard::create_at(path.clone()).unwrap();
        if recovering {
            let record = guard.record().clone();
            drop(guard);
            guard = SessionGuard::adopt(path.clone(), record, vec![]).unwrap();
        }
        let before = std::fs::read(&path).unwrap();
        let result: Result<PhysicalBackend<_, ()>, _> = PhysicalBackend::with_listener(
            "unused.exe".into(),
            false,
            guard,
            Arc::new(ExclusiveSocket::reserve(0).unwrap()),
            |_| Err("fixture listener unavailable".into()),
        );
        assert!(result.is_err());
        if recovering {
            assert_eq!(std::fs::read(&path).unwrap(), before);
        } else {
            assert!(
                !path.exists(),
                "new childless normal guard must be cleaned on listener registration failure"
            );
        }
    }
}
#[test]
fn transaction_reports_stale_or_incomplete_identity_409_and_real_readonly_400() {
    use razer_hid_helper::backend::transact;
    let inventory = fixture_inventory();
    let id = inventory.devices[0].id.clone();
    let inv = serde_json::to_value(&inventory).unwrap();
    let (mut backend, writes, remove) =
        backend_with_signal(vec![inv.clone(), snapshot(), inv.clone(), snapshot()]);
    backend.snapshot(Some(&id)).unwrap();
    remove.store(true, Ordering::SeqCst);
    assert_eq!(
        transact(&mut backend, &change(&id)).unwrap_err().status,
        409,
        "protected writable:false must not hide an attachment conflict"
    );
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    backend.shutdown().unwrap();
    let mut incomplete = inventory;
    incomplete.identity_complete = false;
    let (mut backend, writes) =
        make_backend(vec![serde_json::to_value(incomplete).unwrap(), snapshot()]);
    assert_eq!(
        transact(&mut backend, &change(&id)).unwrap_err().status,
        409
    );
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    backend.shutdown().unwrap();
    let mut readonly = snapshot();
    readonly["settings"][0]["writable"] = false.into();
    let (mut backend, writes) = make_backend(vec![inv, readonly]);
    assert_eq!(
        transact(&mut backend, &change(&id)).unwrap_err().status,
        400
    );
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    backend.shutdown().unwrap();
}
#[test]
fn removal_at_prepared_frame_before_go_prevents_dispatch() {
    let inventory = fixture_inventory();
    let id = inventory.devices[0].id.clone();
    let inv = serde_json::to_value(&inventory).unwrap();
    let path = std::env::temp_dir().join(format!(
        "razer-frame-removal-{}.json",
        razer_hid_helper::process::nonce().unwrap()
    ));
    let guard = SessionGuard::create_with_mode(path, true).unwrap();
    let (attachment, signal) = AttachmentGuard::new();
    let writes = Arc::new(AtomicUsize::new(0));
    let script = Script {
        replies: Mutex::new(vec![inv.clone(), snapshot(), inv, json!({"verified":true})].into()),
        writes: writes.clone(),
        signal,
        remove: Arc::new(AtomicBool::new(false)),
        remove_after_check: Arc::new(AtomicBool::new(true)),
    };
    let mut backend = PhysicalBackend::from_parts(
        script,
        attachment,
        guard,
        true,
        (),
        Arc::new(ExclusiveSocket::reserve(0).unwrap()),
    );
    backend.snapshot(Some(&id)).unwrap();
    let result = backend.apply(&change(&id));
    assert_eq!(
        writes.load(Ordering::SeqCst),
        0,
        "a removal delivered after the old check but before GO must send no write"
    );
    assert_eq!(result.unwrap_err().status, 409);
    backend.shutdown().unwrap();
}
fn recovery_backend(replies: Vec<Value>) -> (PhysicalBackend<Script, ()>, std::path::PathBuf) {
    use razer_hid_helper::session_guard::{PreviousOutcome, WriteRisk};
    let path = std::env::temp_dir().join(format!(
        "razer-recovery-snapshot-{}.json",
        razer_hid_helper::process::nonce().unwrap()
    ));
    let initial = SessionGuard::create_at(path.clone()).unwrap();
    let mut record = initial.record().clone();
    drop(initial);
    let id = fixture_inventory().devices[0].id.clone();
    record.write_risk = WriteRisk::MayHaveWritten;
    record.affected_device_id = Some(id.clone());
    record.previous_outcome = Some(PreviousOutcome::Unknown { device_id: id });
    let guard = SessionGuard::adopt(path.clone(), record, vec![]).unwrap();
    let (attachment, signal) = AttachmentGuard::new();
    let script = Script {
        replies: Mutex::new(replies.into()),
        writes: Arc::new(AtomicUsize::new(0)),
        signal,
        remove: Arc::new(AtomicBool::new(false)),
        remove_after_check: Arc::new(AtomicBool::new(false)),
    };
    (
        PhysicalBackend::from_parts(
            script,
            attachment,
            guard,
            false,
            (),
            Arc::new(ExclusiveSocket::reserve(0).unwrap()),
        ),
        path,
    )
}
#[test]
fn recovery_propagates_inspect_errors_while_public_snapshot_keeps_its_contract() {
    let inventory = fixture_inventory();
    let id = inventory.devices[0].id.clone();
    let inv = serde_json::to_value(inventory).unwrap();
    let error = json!({"fixtureError":"inspect timed out"});
    let (mut backend, path) = recovery_backend(vec![inv.clone(), error.clone(), inv, error]);
    assert_eq!(backend.snapshot(Some(&id)).unwrap()["connected"], false);
    assert_eq!(
        backend.snapshot_for_recovery(&id).unwrap_err().status,
        502,
        "an inspect error is indeterminate rather than evidence that A is unavailable"
    );
    assert!(backend.shutdown().is_err());
    assert!(path.exists());
}
#[test]
fn recovery_requires_complete_inventory_before_acknowledging_absent_a() {
    use razer_hid_helper::{
        recovery::{outcome, ReadPlan},
        session_guard::load,
    };
    let id = fixture_inventory().devices[0].id.clone();
    let incomplete =
        json!({"devices":[],"warnings":["PnP query failed"],"identity_complete":false});
    let (mut backend, path) = recovery_backend(vec![incomplete]);
    assert_eq!(backend.snapshot_for_recovery(&id).unwrap_err().status, 409);
    assert!(backend.shutdown().is_err());
    assert!(path.exists());
    let complete = json!({"devices":[],"warnings":[],"identity_complete":true});
    let (mut backend, path) = recovery_backend(vec![complete]);
    let state = backend.snapshot_for_recovery(&id).unwrap();
    assert_eq!(state["connected"], false);
    let receipt = outcome(
        &load(&path).unwrap(),
        &ReadPlan::Target(id),
        true,
        Some(&state),
    )
    .unwrap();
    assert_eq!(receipt["previousOutcome"], "unresolved");
    backend.finish_recovery(receipt).unwrap();
    assert!(!path.exists());
}
#[test]
fn present_supported_recovery_requires_a_successful_adapter_with_firmware() {
    let inventory = fixture_inventory();
    let id = inventory.devices[0].id.clone();
    let inv = serde_json::to_value(inventory).unwrap();
    for malformed in [
        json!({"connected":false}),
        json!({"connected":true}),
        json!({"connected":true,"model":"Viper","settings":[],"unavailable":[]}),
    ] {
        let (mut backend, path) = recovery_backend(vec![inv.clone(), malformed]);
        assert_eq!(
            backend.snapshot_for_recovery(&id).unwrap_err().status,
            502,
            "present A cannot be observed from a fabricated empty adapter object"
        );
        assert!(backend.shutdown().is_err());
        assert!(path.exists());
    }
    let valid = json!({"connected":true,"model":"Razer Viper V3 Pro SE","message":"fixture","settings":[{"id":"firmware","label":"Firmware","type":"string","writable":false,"value":"1.2"}],"unavailable":[]});
    let (mut backend, path) = recovery_backend(vec![inv, valid]);
    let state = backend.snapshot_for_recovery(&id).unwrap();
    assert_eq!(state["settings"][0]["id"], "firmware");
    assert!(backend.shutdown().is_err());
    assert!(path.exists());
}
#[test]
fn observed_absence_latches_reconnected_identity_read_only_and_prevents_apply() {
    let inventory = fixture_inventory();
    let id = inventory.devices[0].id.clone();
    let empty = json!({"devices":[],"warnings":[],"identity_complete":true});
    let inv = serde_json::to_value(inventory).unwrap();
    let (mut backend, writes) = make_backend(vec![
        inv.clone(),
        snapshot(),
        empty,
        inv.clone(),
        snapshot(),
        inv,
    ]);
    assert_eq!(
        backend.snapshot(Some(&id)).unwrap()["settings"][0]["writable"],
        true
    );
    assert_eq!(backend.snapshot(Some(&id)).unwrap()["connected"], false);
    assert_eq!(
        backend.snapshot(Some(&id)).unwrap()["settings"][0]["writable"],
        false,
        "observed loss must latch even without a callback"
    );
    let error = backend
        .apply(&Change {
            device_id: id,
            id: "sleep".into(),
            value: JsValue::Number(120.),
            expected_value: ExpectedValue::Missing,
        })
        .unwrap_err();
    assert_eq!(error.status, 409);
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    backend.shutdown().unwrap();
}
