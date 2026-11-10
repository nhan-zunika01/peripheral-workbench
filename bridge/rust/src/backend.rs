use crate::{validate_value, ApiError, Change, ExpectedValue, JsValue};
use serde_json::{json, Value};
pub trait Backend {
    fn snapshot(&mut self, device_id: Option<&str>) -> Result<Value, ApiError>;
    fn apply(&mut self, change: &Change) -> Result<Value, ApiError>;
    fn validate_write(&mut self, _: &Change) -> Result<(), ApiError> {
        Ok(())
    }
    fn shutdown(&mut self) -> Result<(), ApiError> {
        Ok(())
    }
}
pub fn transact(backend: &mut dyn Backend, change: &Change) -> Result<Value, ApiError> {
    let state = backend.snapshot(Some(&change.device_id))?;
    if state["selectedDeviceId"] != change.device_id {
        return Err(ApiError::new(409, "Selected device identity changed"));
    }
    if state["connected"] != true {
        return Err(ApiError::new(503, "Device is not connected"));
    }
    backend.validate_write(change)?;
    let schema = state["settings"]
        .as_array()
        .and_then(|settings| settings.iter().find(|setting| setting["id"] == change.id))
        .filter(|schema| schema["writable"] == true)
        .ok_or_else(|| ApiError::new(400, "Setting is not writable"))?;
    if let ExpectedValue::Present(expected) = &change.expected_value {
        if JsValue::from(schema["value"].clone()) != *expected {
            let mut error = ApiError::new(
                409,
                "Device value changed since review. Reload and review it before applying.",
            );
            error.code = Some("STATE_CONFLICT".into());
            error.actual_value = Some(schema["value"].clone());
            return Err(error);
        }
    }
    validate_value(schema, &change.value)?;
    let applied = backend.apply(change)?;
    if applied["verified"] != true {
        return Err(ApiError::new(502, "Native operation could not be verified"));
    }
    let mut refreshed=backend.snapshot(Some(&change.device_id)).unwrap_or_else(|_|json!({"devices":[],"selectedDeviceId":change.device_id,"connected":false,"settings":[],"message":"The operation was confirmed, but refreshing device state failed. Reconnect before making another change."}));
    if refreshed["selectedDeviceId"] != change.device_id {
        refreshed = json!({"devices":refreshed.get("devices").cloned().unwrap_or(json!([])),"selectedDeviceId":change.device_id,"connected":false,"settings":[],"message":"The operation was confirmed, but the refreshed device identity changed. Reconnect before making another change."});
    }
    let mut result = json!({"verified":true,"verification":applied.get("verification").cloned().unwrap_or(json!("hardware-readback")),"state":refreshed});
    if result["state"]["connected"] != true {
        result["warning"]="The operation was confirmed, but refreshing device state failed. Reconnect before making another change.".into();
    }
    Ok(result)
}
