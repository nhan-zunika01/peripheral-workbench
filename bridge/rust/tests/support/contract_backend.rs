use razer_hid_helper::{backend::Backend, ApiError, Change};
use serde_json::{json, Value};
use std::sync::{Arc, Condvar, Mutex};
#[derive(Default)]
pub struct State {
    pub config: Value,
    pub setting: Value,
    pub log: Vec<Value>,
    pub hold: String,
    pub released: bool,
    pub requests: usize,
    pub shared: bool,
    pub writes: bool,
}
pub type Shared = Arc<(Mutex<State>, Condvar)>;
pub struct FakeBackend(pub Shared);
pub fn basic() -> Value {
    json!({"id":"dpi","type":"number","integer":true,"min":100,"max":35000,"writable":true,"value":800})
}
impl Backend for FakeBackend {
    fn snapshot(&mut self, id: Option<&str>) -> Result<Value, ApiError> {
        let (lock, cv) = &*self.0;
        let mut s = lock.lock().unwrap();
        let mut row = json!({"action":"snapshot"});
        if let Some(id) = id {
            row["deviceId"] = id.into()
        }
        s.log.push(row);
        cv.notify_all();
        while s.hold == "first-snapshot" && !s.released {
            s = cv.wait(s).unwrap()
        }
        let mut setting = s.setting.clone();
        if !s.writes {
            setting["writable"] = false.into()
        }
        Ok(
            json!({"connected":s.config.get("connected").cloned().unwrap_or(json!(true)),"selectedDeviceId":if s.shared {id.map(str::to_owned).unwrap_or("b".repeat(24))} else {s.config["selectedDeviceId"].as_str().unwrap_or(&"b".repeat(24)).into()},"settings":if s.shared {vec![]} else {vec![setting]}}),
        )
    }
    fn apply(&mut self, c: &Change) -> Result<Value, ApiError> {
        let (lock, cv) = &*self.0;
        let mut s = lock.lock().unwrap();
        s.log.push(json!({"action":"apply","deviceId":c.device_id,"id":c.id,"value":c.value.to_wire_value()}));
        cv.notify_all();
        while s.hold == "apply" && !s.released {
            s = cv.wait(s).unwrap()
        }
        s.setting["value"] = c.value.to_wire_value();
        Ok(
            json!({"verified":s.config.get("verified").cloned().unwrap_or(json!(true)),"verification":"hardware-readback"}),
        )
    }
}
