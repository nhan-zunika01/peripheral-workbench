use razer_hid_helper::{
    backend::Backend,
    inventory::{collect_results, AttachmentGuard, HidNode},
    physical_backend::PhysicalBackend,
    session_guard::{PreviousOutcome, SessionGuard, WriteRisk},
    socket::ExclusiveSocket,
    worker::{WorkerExecutor, WorkerRequest},
    ApiError,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
#[path = "support/adapter_fake.rs"]
mod adapter_fake;
struct Replies(Mutex<VecDeque<Value>>);
impl WorkerExecutor for Replies {
    fn execute(
        &self,
        _: &WorkerRequest,
        _: &mut SessionGuard,
        permit: razer_hid_helper::dispatch::DispatchPermit,
        check: &mut (dyn FnMut() -> Result<(), ApiError> + Send),
    ) -> Result<Value, ApiError> {
        check()?;
        assert!(permit.commit());
        Ok(self.0.lock().unwrap().pop_front().unwrap())
    }
}
fn recover(adapter: Value) -> (Result<Value, ApiError>, std::path::PathBuf) {
    let hid: Vec<HidNode> = serde_json::from_value(
        json!([{"path":"unit-a","vendorId":5426,"productId":223,"interface":0}]),
    )
    .unwrap();
    let inventory = collect_results(Ok(hid), Ok(vec![]));
    let id = inventory.devices[0].id.clone();
    let path = std::env::temp_dir().join(format!(
        "razer-recovery-values-{}.json",
        razer_hid_helper::process::nonce().unwrap()
    ));
    let initial = SessionGuard::create_at(path.clone()).unwrap();
    let mut record = initial.record().clone();
    drop(initial);
    record.write_risk = WriteRisk::MayHaveWritten;
    record.affected_device_id = Some(id.clone());
    record.previous_outcome = Some(PreviousOutcome::Unknown {
        device_id: id.clone(),
    });
    let guard = SessionGuard::adopt(path.clone(), record, vec![]).unwrap();
    let (attachment, _) = AttachmentGuard::new();
    let replies = Replies(Mutex::new(
        vec![serde_json::to_value(inventory).unwrap(), adapter].into(),
    ));
    let mut backend = PhysicalBackend::from_parts(
        replies,
        attachment,
        guard,
        false,
        (),
        Arc::new(ExclusiveSocket::reserve(0).unwrap()),
    );
    let result = backend.snapshot_for_recovery(&id);
    assert!(backend.shutdown().is_err());
    (result, path)
}
fn valid() -> Value {
    razer_hid_helper::inspect(&mut adapter_fake::FakeExchange::plain(), None).unwrap()
}
fn rejects(invalid_value: bool) {
    let mut adapter = valid();
    let sleep = adapter["settings"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == "sleep")
        .unwrap();
    if invalid_value {
        sleep["value"] = "not-a-number".into();
    } else {
        sleep["writable"] = true.into();
    }
    let (result, path) = recover(adapter);
    assert_eq!(
        result.unwrap_err().status,
        502,
        "recovery must validate every readonly getter value"
    );
    assert!(path.exists());
}
#[test]
fn recovery_rejects_mismatched_value_type() {
    rejects(true)
}
#[test]
fn recovery_rejects_writable_schema() {
    rejects(false)
}
#[test]
fn recovery_accepts_all_real_catalog_readonly_getters_and_quantized_null_baselines() {
    let snapshot = valid();
    assert_eq!(snapshot["settings"].as_array().unwrap().len(), 16);
    assert!(snapshot["settings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["id"] == "smartTracking" && s["value"].is_null()));
    assert!(recover(snapshot.clone()).0.is_ok());
    let mut quantized = snapshot;
    quantized["settings"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == "lowPower")
        .unwrap()["value"] = json!(19);
    assert!(
        recover(quantized).0.is_ok(),
        "lowPower getter flooring is authentic even off the setter step"
    );
    let mut low = valid();
    low["settings"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == "lowPower")
        .unwrap()["value"] = json!(0);
    assert!(
        recover(low).0.is_ok(),
        "raw getter zero is observable although outside setter range"
    );
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/adapter-parity.json")).unwrap();
    for case in fixtures["cases"].as_array().unwrap().iter().filter(|c| {
        c["input"].get("change").is_none() && c["legacy"]["result"]["connected"] == true
    }) {
        let mut io =
            adapter_fake::FakeExchange::new(case["input"].clone(), Arc::new(Mutex::new(vec![])));
        let adapter = razer_hid_helper::inspect(&mut io, None).unwrap();
        assert!(recover(adapter).0.is_ok(), "{}", case["id"]);
    }
}

#[test]
fn recovery_accepts_getter_values_outside_setter_ranges() {
    let cases = [
        ("sleep", "2,7,131", vec![0, 90], json!(90)),
        ("sleep", "2,7,131", vec![0, 0], json!(0)),
        ("sleep", "2,7,131", vec![255, 255], json!(65535)),
        (
            "dpi",
            "7,4,133",
            vec![0, 0, 0, 255, 255],
            json!({"x": 0, "y": 65535}),
        ),
        (
            "dpiStages",
            "80,4,134",
            vec![0, 1, 1, 1, 0, 0, 255, 255, 0, 0],
            json!({"active": 1, "stages": [{"x": 0, "y": 65535}]}),
        ),
        (
            "rotation",
            "3,11,148",
            vec![1, 1, 128],
            json!({"enabled": true, "angle": -128}),
        ),
        (
            "rotation",
            "3,11,148",
            vec![1, 1, 127],
            json!({"enabled": true, "angle": 127}),
        ),
        ("dynamicMode", "2,11,145", vec![1, 255], json!(255)),
        (
            "asymmetricTracking",
            "10,11,133",
            vec![0, 4, 0, 255],
            json!({"liftOff": 1, "landing": 256}),
        ),
    ];
    for (id, command, bytes, expected) in cases {
        let mut io = adapter_fake::FakeExchange::plain();
        io.getters.get_mut(command).unwrap().1 = bytes;
        let snapshot = razer_hid_helper::inspect(&mut io, None).unwrap();
        let result = recover(snapshot)
            .0
            .unwrap_or_else(|error| panic!("{id}: {error:?}"));
        let setting = result["settings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|setting| setting["id"] == id)
            .unwrap();
        assert_eq!(setting["value"], expected, "{id}");
    }

    let mut io = adapter_fake::FakeExchange::plain();
    io.curve[0] = -1.0;
    io.curve[1] = 0.0;
    io.curve[2] = -f32::MAX;
    io.curve[3] = f32::MAX;
    let snapshot = razer_hid_helper::inspect(&mut io, None).unwrap();
    let result = recover(snapshot).0.unwrap();
    let curve = result["settings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|setting| setting["id"] == "customCurve")
        .unwrap();
    assert_eq!(
        &curve["value"].as_array().unwrap()[..4],
        &[
            json!(-1.0),
            json!(0.0),
            json!(-(f32::MAX as f64)),
            json!(f32::MAX as f64)
        ]
    );
}

#[test]
fn recovery_rejects_values_outside_getter_domains() {
    let cases = [
        ("sleep", json!(-1)),
        ("sleep", json!(0.5)),
        ("sleep", json!(65536)),
        ("dpi", json!({"x": -1, "y": 800})),
        (
            "dpiStages",
            json!({"active": 2, "stages": [{"x": 800, "y": 800}]}),
        ),
        ("rotation", json!({"enabled": true, "angle": 128})),
        ("dynamicMode", json!(256)),
        ("asymmetricTracking", json!({"liftOff": 0, "landing": 257})),
    ];
    for (id, value) in cases {
        let mut snapshot = valid();
        snapshot["settings"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|setting| setting["id"] == id)
            .unwrap()["value"] = value;
        let (result, path) = recover(snapshot);
        assert_eq!(result.unwrap_err().status, 502, "{id}");
        assert!(path.exists(), "{id}");
    }
}
