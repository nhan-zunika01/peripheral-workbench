use crate::{ApiError, JsValue};
use serde_json::{json, Value};

pub fn validate_value(schema: &Value, value: &JsValue) -> Result<(), ApiError> {
    validate(schema, value, 0)
}
fn fail(message: &str) -> Result<(), ApiError> {
    Err(ApiError::new(400, message))
}
fn validate(s: &Value, v: &JsValue, depth: usize) -> Result<(), ApiError> {
    let kind = s["type"].as_str().unwrap_or("");
    if depth > 6 || !["number", "boolean", "string", "object", "array", "json"].contains(&kind) {
        return fail("Unsupported setting schema");
    }
    match kind {
        "json" => {
            if s["format"] == "curve" {
                return if matches!(v,JsValue::Array(items) if items.len()==250 && items.iter().all(|v|v.number().map(|n|n.is_finite() && (0.1..=f32::MAX as f64).contains(&n)).unwrap_or(false)))
                {
                    Ok(())
                } else {
                    fail("Custom curves require exactly 250 finite positive Float32 values")
                };
            }
            return fail("Unsupported JSON setting");
        }
        "array" => {
            let JsValue::Array(items) = v else {
                return fail("Incorrect array length");
            };
            if items.len() < s["minItems"].as_u64().unwrap_or(0) as usize
                || items.len() > s["maxItems"].as_u64().unwrap_or(20) as usize
            {
                return fail("Incorrect array length");
            }
            for item in items {
                validate(&s["items"], item, depth + 1)?
            }
            return Ok(());
        }
        "object" => {
            let (JsValue::Object(fields), Some(properties)) = (v, s["properties"].as_object())
            else {
                return fail("Incorrect setting fields");
            };
            if fields.len() != properties.len()
                || !fields.keys().all(|key| properties.contains_key(key))
            {
                return fail("Incorrect setting fields");
            }
            for (key, child) in properties {
                validate(child, &fields[key], depth + 1)?
            }
            return Ok(());
        }
        "number" => {
            let JsValue::Number(n) = v else {
                return fail("Incorrect value type");
            };
            if !n.is_finite()
                || s["integer"] == true && n.fract() != 0.
                || s["min"].as_f64().map(|min| *n < min).unwrap_or(false)
                || s["max"].as_f64().map(|max| *n > max).unwrap_or(false)
            {
                return fail("Value outside supported range");
            }
            if let Some(step) = s["step"].as_f64().filter(|n| *n != 0.) {
                let units = (*n - s["min"].as_f64().unwrap_or(0.)) / step;
                if (units - units.round()).abs() > 1e-8 {
                    return fail("Value does not match the supported step");
                }
            }
        }
        "boolean" => {
            if !matches!(v, JsValue::Bool(_)) {
                return fail("Incorrect value type");
            }
        }
        "string" => {
            let JsValue::String(text) = v else {
                return fail("Incorrect value type");
            };
            if text.encode_utf16().count() > 256 {
                return fail("Value too long");
            }
        }
        _ => unreachable!(),
    }
    if let Some(options) = s["options"].as_array() {
        if !options.iter().any(|o| {
            let option =
                JsValue::from(o.get("value").filter(|v| !v.is_null()).unwrap_or(o).clone());
            match (&option, v) {
                (JsValue::Number(a), JsValue::Number(b)) => a == b,
                _ => option == *v,
            }
        }) {
            return fail("Unsupported value");
        }
    }
    Ok(())
}

fn number(label: &str, min: i32, max: i32) -> Value {
    json!({"type":"number","label":label,"integer":true,"min":min,"max":max})
}
fn axes() -> Value {
    json!({"x":number("X axis",100,35000),"y":number("Y axis",100,35000)})
}
pub(crate) fn catalog() -> Vec<Value> {
    let rows = vec![
        (
            "dpi",
            "Current DPI",
            json!({"type":"object","properties":axes()}),
            true,
        ),
        (
            "dpiStages",
            "DPI stages",
            json!({"type":"object","properties":{"active":number("Active stage",1,5),"stages":{"type":"array","label":"Stages","minItems":1,"maxItems":5,"items":{"type":"object","properties":axes()}}}}),
            true,
        ),
        (
            "polling",
            "Polling rate (Hz)",
            json!({"type":"number","options":[125,500,1000]}),
            true,
        ),
        (
            "pollingWired",
            "Wired polling rate (Hz)",
            json!({"type":"number","options":[125,500,1000]}),
            true,
        ),
        (
            "pollingWireless",
            "Wireless polling rate (Hz)",
            json!({"type":"number","options":[125,500,1000]}),
            true,
        ),
        ("battery", "Battery (%)", number("Battery", 0, 100), false),
        (
            "sleep",
            "Idle sleep (seconds)",
            number("Idle sleep", 60, 900),
            true,
        ),
        (
            "lowPower",
            "Low power threshold (%)",
            number("Low power threshold", 5, 100),
            true,
        ),
        (
            "rotation",
            "Sensor rotation",
            json!({"type":"object","properties":{"enabled":{"type":"boolean","label":"Enabled"},"angle":number("Angle (degrees)",-44,44)}}),
            true,
        ),
        (
            "dynamicState",
            "Dynamic sensitivity enabled",
            json!({"type":"boolean"}),
            true,
        ),
        (
            "dynamicMode",
            "Dynamic sensitivity mode",
            json!({"type":"number","options":[{"value":0,"label":"Classic"},{"value":1,"label":"Natural"},{"value":2,"label":"Jump"},{"value":3,"label":"Custom (existing curve)"}]}),
            true,
        ),
        (
            "customCurve",
            "Custom sensitivity curve (250 points)",
            json!({"type":"array","minItems":250,"maxItems":250,"itemLabel":"Point","description":"Applies custom mode and enables dynamic sensitivity. Values use firmware Float32 precision.","items":{"type":"number","min":0.1,"max":f32::MAX as f64}}),
            true,
        ),
        (
            "calibrationState",
            "Tracking sensor enabled",
            json!({"type":"boolean"}),
            false,
        ),
        (
            "asymmetricTracking",
            "Asymmetric tracking distances",
            json!({"type":"object","description":"Applying these distances enables asymmetric tracking.","properties":{"liftOff":number("Lift-off level",2,26),"landing":number("Landing level",1,25)}}),
            true,
        ),
        (
            "smartTracking",
            "Set smart tracking distance",
            json!({"type":"number","min":1,"max":3,"integer":true,"description":"Enter a level from 1 to 3 to enable smart tracking. The firmware has no independent mode getter; confirmation uses its command acknowledgement."}),
            true,
        ),
    ];
    rows.into_iter()
        .map(|(id, label, mut schema, writable)| {
            schema["id"] = id.into();
            schema["label"] = label.into();
            schema["writable"] = writable.into();
            if id == "sleep" {
                schema["step"] = 60.into()
            }
            if id == "lowPower" {
                schema["step"] = 5.into()
            }
            schema
        })
        .collect()
}
