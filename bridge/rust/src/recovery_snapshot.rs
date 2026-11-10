use crate::{validate_value, JsValue};
use serde_json::{json, Value};
pub(crate) fn valid(value: &Value) -> bool {
    let text = |field: &Value| field.as_str().is_some_and(|text| !text.is_empty());
    let Some(settings) = value["settings"].as_array() else {
        return false;
    };
    if value["connected"] != true
        || !text(&value["model"])
        || !value["unavailable"]
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string))
        || !value.get("message").is_none_or(Value::is_string)
        || !value.as_object().is_some_and(|fields| {
            fields.keys().all(|key| {
                ["connected", "model", "message", "settings", "unavailable"].contains(&key.as_str())
            })
        })
    {
        return false;
    }
    let catalog = crate::schema::catalog();
    let mut seen = std::collections::BTreeSet::new();
    for setting in settings {
        let Some(id) = setting["id"].as_str() else {
            return false;
        };
        if !seen.insert(id) || setting["writable"] != false {
            return false;
        }
        let Some(value) = setting.get("value") else {
            return false;
        };
        let mut expected = if id == "firmware" {
            json!({"id":"firmware","label":"Firmware","type":"string","writable":false})
        } else {
            let Some(schema) = catalog.iter().find(|schema| schema["id"] == id) else {
                return false;
            };
            schema.clone()
        };
        expected["writable"] = false.into();
        let mut metadata = setting.clone();
        metadata.as_object_mut().unwrap().remove("value");
        if metadata != expected {
            return false;
        }
        if id == "smartTracking" && value.is_null() {
            continue;
        }
        // Getter values can span their wire types beyond the setter's accepted ranges.
        match id {
            "sleep" | "lowPower" => {
                expected.as_object_mut().unwrap().remove("step");
                expected["min"] = 0.into();
                if id == "sleep" {
                    expected["max"] = u16::MAX.into();
                }
            }
            "dpi" | "dpiStages" => {
                if id == "dpiStages"
                    && value["active"]
                        .as_f64()
                        .zip(value["stages"].as_array())
                        .is_some_and(|(active, stages)| active > stages.len() as f64)
                {
                    return false;
                }
                let axes = if id == "dpi" {
                    &mut expected["properties"]
                } else {
                    &mut expected["properties"]["stages"]["items"]["properties"]
                };
                for axis in ["x", "y"] {
                    axes[axis]["min"] = 0.into();
                    axes[axis]["max"] = u16::MAX.into();
                }
            }
            "rotation" => {
                expected["properties"]["angle"]["min"] = i8::MIN.into();
                expected["properties"]["angle"]["max"] = i8::MAX.into();
            }
            "dynamicMode" => {
                expected.as_object_mut().unwrap().remove("options");
                expected["integer"] = true.into();
                expected["min"] = 0.into();
                expected["max"] = u8::MAX.into();
            }
            "customCurve" => expected["items"]["min"] = (-(f32::MAX as f64)).into(),
            "asymmetricTracking" => {
                for distance in ["liftOff", "landing"] {
                    expected["properties"][distance]["min"] = 1.into();
                    expected["properties"][distance]["max"] = 256.into();
                }
            }
            _ => {}
        }
        if validate_value(&expected, &JsValue::from(value.clone())).is_err()
            || (id == "firmware" && !text(value))
        {
            return false;
        }
    }
    seen.contains("firmware")
}
