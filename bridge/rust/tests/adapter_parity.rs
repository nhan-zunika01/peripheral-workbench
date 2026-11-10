use razer_hid_helper::{
    adapter::{inspect_target, inspect_with_mode, Exchange},
    validate_value, Change, ExpectedValue, JsValue,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
#[path = "support/adapter_fake.rs"]
mod adapter_fake;
use adapter_fake::FakeExchange;

#[test]
fn frozen_adapter_results_and_complete_command_transcripts() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/adapter-parity.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let input = &case["input"];
        let log = Arc::new(Mutex::new(Vec::new()));
        let devices = input.get("devices").cloned().unwrap_or(json!([{"vendorId":5426,"productId":223,"interface":0,"usagePage":1,"usage":2,"path":"fake-unit-a"}]));
        let nodes: Vec<razer_hid_helper::inventory::HidNode> =
            serde_json::from_value(devices).unwrap();
        let paths: Vec<String> = serde_json::from_value(
            input
                .get("target")
                .cloned()
                .unwrap_or(json!(["fake-unit-a"])),
        )
        .unwrap();
        let change = input.get("change").map(|c| Change {
            device_id: "b".repeat(24),
            id: c["id"].as_str().unwrap().into(),
            value: JsValue::from(c["value"].clone()),
            expected_value: ExpectedValue::Missing,
        });
        let result = inspect_target(&nodes, &paths, change.as_ref(), true, |node| {
            log.lock()
                .unwrap()
                .push(json!({"action":"open","path":node.path}));
            Ok(Box::new(FakeExchange::new(input.clone(), log.clone())) as Box<dyn Exchange>)
        });
        match result {
            Ok(value) => assert_eq!(
                JsValue::from(value),
                JsValue::from(case["legacy"]["result"].clone()),
                "{}",
                case["id"]
            ),
            Err(error) => assert_eq!(
                error.error,
                case["legacy"]["error"].as_str().unwrap(),
                "{}",
                case["id"]
            ),
        }
        assert_eq!(
            *log.lock().unwrap(),
            case["legacy"]["transcript"].as_array().unwrap().clone(),
            "{} transcript",
            case["id"]
        );
    }
}

#[test]
fn parser_normalizes_binary64_and_keeps_private_signed_zero() {
    let a = JsValue::parse(b"9007199254740993").unwrap();
    assert_eq!(a, JsValue::parse(b"9007199254740992.0").unwrap());
    assert_ne!(
        JsValue::parse(b"-0").unwrap(),
        JsValue::parse(b"0").unwrap()
    );
    assert_eq!(JsValue::parse(b"-0").unwrap().to_wire_value(), json!(0));
    for text in [
        b"{\"x\":1,\"x\":2}".as_slice(),
        b"1e400",
        br#""\uD800""#,
        b"\"\xff\"",
    ] {
        assert_eq!(JsValue::parse(text).unwrap_err().status, 400);
    }
    let raw = format!("{}0{}", "[".repeat(65), "]".repeat(65));
    assert!(JsValue::parse(raw.as_bytes()).is_err());
    assert_eq!(
        JsValue::parse(br#"{"b":2,"a":[1,-0]}"#).unwrap(),
        JsValue::parse(br#"{"a":[1.0,-0.0],"b":2.0}"#).unwrap()
    );
}

#[test]
fn read_only_rejects_before_exchange_and_projects_every_schema() {
    let mut io = FakeExchange::plain();
    let change = Change {
        device_id: "b".repeat(24),
        id: "dpi".into(),
        value: JsValue::from(json!({"x":1600,"y":1600})),
        expected_value: ExpectedValue::Missing,
    };
    assert_eq!(
        inspect_with_mode(&mut io, Some(&change), false)
            .unwrap_err()
            .status,
        400
    );
    assert!(io.log.lock().unwrap().is_empty());
    let state = inspect_with_mode(&mut io, None, false).unwrap();
    assert!(state["settings"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["writable"] == false));
}

#[test]
fn validator_matches_frozen_raw_boundary_corpus() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/companion-contract.json"
    ))
    .unwrap();
    for case in fixture["wire"].as_array().unwrap() {
        let Some(schema) = case["input"]["backend"].get("setting") else {
            continue;
        };
        let Some(raw) = case["input"].get("raw").and_then(Value::as_str) else {
            continue;
        };
        let Ok(change) = JsValue::parse(raw.as_bytes()) else {
            continue;
        };
        let JsValue::Object(fields) = change else {
            continue;
        };
        let value = &fields["value"];
        let result = validate_value(schema, value);
        if [
            "signed-zero",
            "object-conflict",
            "array-order",
            "null-actual",
            "null-equal",
            "read-only",
        ]
        .contains(&case["id"].as_str().unwrap())
        {
            continue;
        }
        let status = case["legacy"]["status"].as_u64().unwrap_or(0);
        if status == 400 {
            assert!(result.is_err(), "{}", case["id"]);
        } else if status == 200 {
            assert!(result.is_ok(), "{}: {:?}", case["id"], result);
        }
    }
}

#[test]
fn numeric_option_accepts_negative_zero_like_javascript_strict_equality() {
    assert!(validate_value(
        &json!({"type":"number","options":[0]}),
        &JsValue::parse(b"-0").unwrap()
    )
    .is_ok());
}

#[test]
fn structural_depth_counts_empty_containers_and_cannot_bypass_direct_deserialize() {
    for (open, close) in [("[", "]"), ("{\"x\":", "}")] {
        let valid = format!("{}{}", open.repeat(64), close.repeat(64));
        let valid = if open == "[" {
            valid
        } else {
            format!("{}{{}}{}", open.repeat(63), close.repeat(63))
        };
        assert!(JsValue::parse(valid.as_bytes()).is_ok());
        let invalid = if open == "[" {
            format!("{}{}", open.repeat(65), close.repeat(65))
        } else {
            format!("{}{{}}{}", open.repeat(64), close.repeat(64))
        };
        assert!(
            JsValue::parse(invalid.as_bytes()).is_err(),
            "depth65: {invalid}"
        );
        assert!(serde_json::from_str::<JsValue>(&invalid).is_err());
    }
    for invalid in [r#"{"x":{"y":1,"y":2}}"#, "1e400", r#""\uD800""#] {
        assert!(serde_json::from_str::<JsValue>(invalid).is_err());
    }
}

#[test]
fn numeric_usage_metadata_prefers_the_mouse_interface_independent_of_json_spelling() {
    let nodes: Vec<razer_hid_helper::inventory::HidNode>=serde_json::from_value(json!([
        {"vendorId":5426,"productId":223,"interface":0,"path":"fallback","usagePage":0,"usage":0},
        {"vendorId":5426,"productId":223,"interface":0,"path":"preferred","usagePage":1.0,"usage":2.0}
    ])).unwrap();
    let mut opened = Vec::new();
    inspect_target(
        &nodes,
        &["fallback".into(), "preferred".into()],
        None,
        false,
        |node| {
            opened.push(node.path.clone());
            Ok(Box::new(FakeExchange::plain()))
        },
    )
    .unwrap();
    assert_eq!(opened, ["preferred"]);
}

#[test]
fn conflict_error_private_roundtrip_keeps_explicit_actual_null() {
    let error = razer_hid_helper::ApiError {
        status: 409,
        error: "Changed".into(),
        code: Some("STATE_CONFLICT".into()),
        actual_value: Some(Value::Null),
        internal: false,
    };
    let bytes = serde_json::to_vec(&error).unwrap();
    let decoded: razer_hid_helper::ApiError = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(decoded.actual_value, Some(Value::Null));
    let result = serde_json::to_value(decoded).unwrap();
    assert!(result.get("actualValue").is_some());
    let absent: razer_hid_helper::ApiError =
        serde_json::from_value(json!({"status":502,"error":"Failure"})).unwrap();
    assert!(serde_json::to_value(absent)
        .unwrap()
        .get("actualValue")
        .is_none());
}

#[test]
fn typed_worker_errors_cannot_bypass_nested_json_guards() {
    let duplicate = r#"{"status":409,"error":"Changed","actualValue":{"x":1,"x":2}}"#;
    assert!(serde_json::from_str::<razer_hid_helper::ApiError>(duplicate).is_err());
    let overdepth = format!(
        r#"{{"status":409,"error":"Changed","actualValue":{}0{}}}"#,
        "[".repeat(64),
        "]".repeat(64)
    );
    assert!(serde_json::from_str::<razer_hid_helper::ApiError>(&overdepth).is_err());
    let private: razer_hid_helper::ApiError = serde_json::from_str(
        r#"{"status":409,"error":"Changed","actualValue":{"x":-0,"y":9007199254740993}}"#,
    )
    .unwrap();
    let actual = private.actual_value.unwrap();
    assert!(actual["x"].as_f64().unwrap().is_sign_negative());
    assert_eq!(
        serde_json::to_string(&actual["y"]).unwrap(),
        "9007199254740992.0"
    );
}

fn change(id: &str, value: Value) -> Change {
    Change {
        device_id: "b".repeat(24),
        id: id.into(),
        value: JsValue::from(value),
        expected_value: ExpectedValue::Missing,
    }
}

#[test]
fn read_only_metadata_is_exact_with_only_writable_overridden() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/adapter-parity.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap().iter().filter(|c| {
        c["input"].get("change").is_none() && c["legacy"]["result"]["connected"] == true
    }) {
        let mut io = FakeExchange::new(case["input"].clone(), Arc::new(Mutex::new(Vec::new())));
        let actual = razer_hid_helper::inspect(&mut io, None).unwrap();
        let mut expected = case["legacy"]["result"].clone();
        for setting in expected["settings"].as_array_mut().unwrap() {
            setting["writable"] = false.into()
        }
        assert_eq!(
            JsValue::from(actual),
            JsValue::from(expected),
            "{}",
            case["id"]
        );
    }
}

#[test]
fn every_short_getter_is_partial_but_short_firmware_is_fatal() {
    for (key, id, minimum) in [
        ("7,4,133", "dpi", 5),
        ("80,4,134", "dpiStages", 3),
        ("1,0,133", "polling", 1),
        ("2,0,192:0", "pollingWired", 2),
        ("2,0,192:1", "pollingWireless", 2),
        ("2,7,128", "battery", 2),
        ("2,7,131", "sleep", 2),
        ("1,7,129", "lowPower", 1),
        ("3,11,148", "rotation", 3),
        ("2,11,144", "dynamicState", 2),
        ("2,11,145", "dynamicMode", 2),
        ("3,11,131", "calibrationState", 3),
        ("10,11,133", "asymmetricTracking", 4),
    ] {
        for len in 0..minimum {
            let mut io = FakeExchange::plain();
            io.getters.get_mut(key).unwrap().1.truncate(len);
            let state = inspect_with_mode(&mut io, None, true).unwrap();
            assert!(
                !state["settings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|s| s["id"] == id),
                "{id} len{len}"
            );
            assert!(state["unavailable"][0]
                .as_str()
                .unwrap()
                .ends_with("Invalid setting response length"));
        }
    }
    for len in 0..2 {
        let mut io = FakeExchange::plain();
        io.getters.get_mut("2,0,129").unwrap().1.truncate(len);
        assert!(inspect_with_mode(&mut io, None, true)
            .unwrap_err()
            .error
            .ends_with("Invalid firmware response"));
        assert_eq!(io.log.lock().unwrap().len(), 1);
    }
}

#[test]
fn unrecognized_rates_and_invalid_stage_headers_never_publish_setting() {
    for (key, id) in [
        ("1,0,133", "polling"),
        ("2,0,192:0", "pollingWired"),
        ("2,0,192:1", "pollingWireless"),
    ] {
        let mut io = FakeExchange::plain();
        let bytes = &mut io.getters.get_mut(key).unwrap().1;
        *bytes.last_mut().unwrap() = 255;
        let state = inspect_with_mode(&mut io, None, true).unwrap();
        assert!(!state["settings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == id));
        assert!(state["unavailable"][0]
            .as_str()
            .unwrap()
            .ends_with("Unsupported polling response"));
    }
    for bytes in [
        vec![0, 0, 1],
        vec![0, 2, 1],
        vec![0, 1, 0],
        vec![0, 1, 6],
        vec![0, 1, 1, 1, 3, 32],
    ] {
        let mut io = FakeExchange::plain();
        io.getters.get_mut("80,4,134").unwrap().1 = bytes;
        let state = inspect_with_mode(&mut io, None, true).unwrap();
        assert!(state["unavailable"][0]
            .as_str()
            .unwrap()
            .ends_with("Invalid DPI stages response"));
    }
}

#[test]
fn stage_ids_are_preserved_and_extension_uses_first_returned_id() {
    let mut io = FakeExchange::plain();
    io.getters.get_mut("80,4,134").unwrap().1 =
        vec![0, 1, 2, 7, 3, 32, 3, 32, 0, 0, 42, 3, 32, 3, 32, 0, 0];
    let next = change(
        "dpiStages",
        json!({"active":3,"stages":[{"x":100,"y":35000},{"x":35000,"y":100},{"x":800,"y":1600}]}),
    );
    inspect_with_mode(&mut io, Some(&next), true).unwrap();
    let log = io.log.lock().unwrap();
    let write = log
        .iter()
        .find(|e| e["command"] == json!([24, 4, 6]))
        .unwrap();
    assert_eq!(
        write["data"],
        json!([
            0, 3, 3, 7, 0, 100, 136, 184, 0, 0, 42, 136, 184, 0, 100, 0, 0, 9, 3, 32, 6, 64, 0, 0
        ])
    );
}

#[test]
fn worker_revalidates_ranges_steps_and_cross_field_relations_before_writes() {
    for (id, value, message) in [
        (
            "dpi",
            json!({"x":99,"y":800}),
            "Value outside supported range",
        ),
        (
            "dpi",
            json!({"x":800,"y":35001}),
            "Value outside supported range",
        ),
        (
            "dpiStages",
            json!({"active":2,"stages":[{"x":800,"y":800}]}),
            "Active stage exceeds the stage count",
        ),
        (
            "sleep",
            json!(61),
            "Value does not match the supported step",
        ),
        (
            "lowPower",
            json!(29),
            "Value does not match the supported step",
        ),
        ("dynamicMode", json!(4), "Unsupported value"),
        (
            "rotation",
            json!({"enabled":true,"angle":45}),
            "Value outside supported range",
        ),
        ("smartTracking", json!(null), "Incorrect value type"),
        (
            "asymmetricTracking",
            json!({"liftOff":2,"landing":2}),
            "Landing distance must be below lift-off distance",
        ),
    ] {
        let mut io = FakeExchange::plain();
        let next = change(id, value);
        assert_eq!(
            inspect_with_mode(&mut io, Some(&next), true)
                .unwrap_err()
                .error,
            message
        );
        assert!(
            io.log
                .lock()
                .unwrap()
                .iter()
                .all(|e| e["command"][2].as_u64().unwrap() >= 128),
            "{id}"
        );
    }
    let mut io = FakeExchange::plain();
    io.getters.get_mut("1,7,129").unwrap().1 = vec![76];
    let state = inspect_with_mode(&mut io, None, true).unwrap();
    assert_eq!(
        state["settings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == "lowPower")
            .unwrap()["value"],
        json!(29.0)
    );
}

#[path = "support/adapter_edges.rs"]
mod adapter_edges;
