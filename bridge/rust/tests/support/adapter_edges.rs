use super::*;

#[test]
fn float32_normalization_and_tracking_side_effects_have_no_automatic_restore() {
    for point in [f64::INFINITY, f64::NAN, f32::MAX as f64 * 1.000001, 0.09999] {
        let mut io = FakeExchange::plain();
        let mut next = change("customCurve", json!(vec![1.; 250]));
        let JsValue::Array(points) = &mut next.value else {
            unreachable!()
        };
        points[0] = JsValue::Number(point);
        assert!(inspect_with_mode(&mut io, Some(&next), true).is_err());
        assert!(io
            .log
            .lock()
            .unwrap()
            .iter()
            .all(|e| e["command"][2].as_u64().unwrap() >= 128));
    }
    for point in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut io = FakeExchange::plain();
        io.curve[16] = point;
        let state = inspect_with_mode(&mut io, None, true).unwrap();
        assert!(state["unavailable"][0]
            .as_str()
            .unwrap()
            .ends_with("Invalid custom curve point"));
        let offsets: Vec<_> = io
            .log
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["command"] == json!([37, 11, 147]))
            .map(|e| e["data"][3].as_u64().unwrap())
            .collect();
        assert_eq!(offsets, [0, 8, 16]);
    }
    let mut io = FakeExchange::new(json!({"failCurveAt":16}), Arc::new(Mutex::new(Vec::new())));
    let next = change("customCurve", json!(vec![0.1; 250]));
    assert_eq!(
        inspect_with_mode(&mut io, Some(&next), true)
            .unwrap_err()
            .error,
        "Simulated uncertain chunk"
    );
    let log = io.log.lock().unwrap();
    let writes: Vec<_> = log
        .iter()
        .filter(|e| e["command"][2].as_u64().unwrap() < 128)
        .collect();
    assert_eq!(writes.len(), 5);
    assert_eq!(writes[0]["data"], json!([1, 1]));
    assert_eq!(writes[1]["data"], json!([1, 3]));
    assert_eq!(writes[2]["data"][5], json!(205));
    assert_eq!(writes[2]["data"][6], json!(204));
    assert_eq!(writes[4]["data"][3], json!(16));
}

#[test]
fn text_limits_are_utf16_and_changes_keep_missing_distinct_from_null_privately() {
    let schema = json!({"type":"string"});
    assert!(validate_value(&schema, &JsValue::String("🦊".repeat(128))).is_ok());
    assert_eq!(
        validate_value(&schema, &JsValue::String("🦊".repeat(129)))
            .unwrap_err()
            .error,
        "Value too long"
    );
    let missing =
        Change::parse(br#"{"deviceId":"bbbbbbbbbbbbbbbbbbbbbbbb","id":"dpi","value":800}"#)
            .unwrap();
    assert_eq!(missing.expected_value, ExpectedValue::Missing);
    assert!(serde_json::to_value(&missing)
        .unwrap()
        .get("expectedValue")
        .is_none());
    let null=Change::parse(br#"{"deviceId":"bbbbbbbbbbbbbbbbbbbbbbbb","id":"smartTracking","value":3,"expectedValue":null}"#).unwrap();
    assert_eq!(null.expected_value, ExpectedValue::Present(JsValue::Null));
    assert!(serde_json::to_value(&null)
        .unwrap()
        .get("expectedValue")
        .unwrap()
        .is_null());
    let zero=Change::parse(br#"{"deviceId":"bbbbbbbbbbbbbbbbbbbbbbbb","id":"rotation","value":{"enabled":false,"angle":1},"expectedValue":{"enabled":false,"angle":-0}}"#).unwrap();
    assert_eq!(
        serde_json::from_slice::<Change>(&serde_json::to_vec(&zero).unwrap()).unwrap(),
        zero
    );
    for raw in [
        r#"{"deviceId":"BBBBBBBBBBBBBBBBBBBBBBBB","id":"dpi","value":800}"#,
        r#"{"deviceId":"bbbbbbbbbbbbbbbbbbbbbbbb","id":"dpi","value":800,"value":800}"#,
        r#"{"deviceId":"bbbbbbbbbbbbbbbbbbbbbbbb","id":"dpi","value":{"x":1,"x":2}}"#,
    ] {
        assert!(serde_json::from_str::<Change>(raw).is_err());
    }
}

#[test]
fn polling_maps_cover_every_supported_rate_in_both_directions() {
    for (id, key, profile) in [
        ("polling", "1,0,133", None),
        ("pollingWired", "2,0,192:0", Some(0)),
        ("pollingWireless", "2,0,192:1", Some(1)),
    ] {
        for (rate, normal, high) in [(125, 8, 64), (500, 2, 16), (1000, 1, 8)] {
            let mut io = FakeExchange::plain();
            io.getters.get_mut(key).unwrap().1 = if let Some(p) = profile {
                vec![p, high]
            } else {
                vec![normal]
            };
            let state = inspect_with_mode(&mut io, None, true).unwrap();
            assert_eq!(
                state["settings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["id"] == id)
                    .unwrap()["value"],
                rate
            );
            let next = change(id, json!(rate));
            inspect_with_mode(&mut io, Some(&next), true).unwrap();
            let log = io.log.lock().unwrap();
            let write = log
                .iter()
                .find(|e| e["command"][2].as_u64().unwrap() < 128)
                .unwrap();
            let (command, data) = if let Some(p) = profile {
                (json!([2, 0, 64]), json!([p, high]))
            } else {
                (json!([1, 0, 5]), json!([normal]))
            };
            assert_eq!(write["command"], command);
            assert_eq!(write["data"], data);
        }
    }
}

#[test]
fn schema_depth_step_tolerance_and_exact_object_fields_match_validator() {
    for depth in [6, 7] {
        let mut schema = json!({"type":"number"});
        let mut value = JsValue::Number(1.);
        for _ in 0..depth {
            schema = json!({"type":"array","items":schema});
            value = JsValue::Array(vec![value]);
        }
        assert_eq!(validate_value(&schema, &value).is_ok(), depth == 6);
    }
    let step = json!({"type":"number","min":0,"step":1});
    assert!(validate_value(&step, &JsValue::Number(1. + 0.000000005)).is_ok());
    assert_eq!(
        validate_value(&step, &JsValue::Number(1. + 0.00000002))
            .unwrap_err()
            .error,
        "Value does not match the supported step"
    );
    for value in [json!({}), json!({"x":1,"y":2})] {
        assert_eq!(
            validate_value(
                &json!({"type":"object","properties":{"x":{"type":"number"}}}),
                &JsValue::from(value)
            )
            .unwrap_err()
            .error,
            "Incorrect setting fields"
        );
    }
    assert_eq!(
        validate_value(
            &json!({"type":"json","format":"mapping-list"}),
            &JsValue::Array(vec![])
        )
        .unwrap_err()
        .error,
        "Unsupported JSON setting"
    );
}

#[test]
fn low_power_quantized_mismatch_and_rotation_signed_zero_remain_failures() {
    let mut io = FakeExchange::new(json!({"dropWrites":true}), Arc::new(Mutex::new(Vec::new())));
    io.getters.get_mut("1,7,129").unwrap().1 = vec![76];
    let next = change("lowPower", json!(30));
    assert_eq!(
        inspect_with_mode(&mut io, Some(&next), true)
            .unwrap_err()
            .error,
        "Device readback differs from the requested value"
    );
    let log = io.log.lock().unwrap();
    assert_eq!(log[log.len() - 2]["data"], json!([77]));
    drop(log);
    let mut io = FakeExchange::plain();
    let mut next = change("rotation", json!({"enabled":false,"angle":0}));
    let JsValue::Object(fields) = &mut next.value else {
        unreachable!()
    };
    fields.insert("angle".into(), JsValue::Number(-0.));
    assert_eq!(
        inspect_with_mode(&mut io, Some(&next), true)
            .unwrap_err()
            .error,
        "Device readback differs from the requested value"
    );
}

#[test]
fn asymmetric_tracking_and_smart_tracking_emit_only_the_documented_side_effects() {
    for (id, value, expected) in [
        (
            "asymmetricTracking",
            json!({"liftOff":26,"landing":25}),
            json!([
            {"action":"exchange","command":[3,11,3],"data":[0,4,1]},
            {"action":"exchange","command":[4,11,11],"data":[0,4,4,0]},
            {"action":"exchange","command":[10,11,5],"data":[0,4,25,24]}]),
        ),
        (
            "smartTracking",
            json!(1),
            json!([
            {"action":"exchange","command":[3,11,3],"data":[0,4,1]},
            {"action":"exchange","command":[4,11,11],"data":[0,4,1,0]}]),
        ),
    ] {
        let mut io = FakeExchange::plain();
        let next = change(id, value);
        let result = inspect_with_mode(&mut io, Some(&next), true).unwrap();
        let log = io.log.lock().unwrap();
        let writes: Vec<_> = log
            .iter()
            .filter(|e| e["command"][2].as_u64().unwrap() < 128)
            .cloned()
            .collect();
        assert_eq!(json!(writes), expected);
        assert_eq!(
            result["verification"],
            if id == "smartTracking" {
                "hardware-acknowledgement"
            } else {
                "hardware-readback"
            }
        );
    }
}

#[test]
fn unsupported_targets_and_read_only_apply_cannot_construct_exchange() {
    let nodes: Vec<razer_hid_helper::inventory::HidNode> = serde_json::from_value(
        json!([{"vendorId":5426,"productId":4660,"interface":0,"path":"unknown"}]),
    )
    .unwrap();
    let mut opens = 0;
    let result = inspect_target(&nodes, &["unknown".into()], None, true, |_| {
        opens += 1;
        Ok(Box::new(FakeExchange::plain()))
    });
    assert!(result.is_err());
    assert_eq!(opens, 0);
    let next = change("dpi", json!({"x":800,"y":800}));
    let result = inspect_target(&nodes, &["unknown".into()], Some(&next), false, |_| {
        opens += 1;
        Ok(Box::new(FakeExchange::plain()))
    });
    assert_eq!(result.unwrap_err().status, 400);
    assert_eq!(opens, 0);
}

#[test]
fn malformed_curve_headers_are_partial_and_stop_the_curve_probe_immediately() {
    struct Malformed {
        inner: FakeExchange,
        reply: Vec<u8>,
    }
    impl Exchange for Malformed {
        fn exchange(
            &mut self,
            command: [u8; 3],
            data: &[u8],
        ) -> Result<Vec<u8>, razer_hid_helper::ApiError> {
            let value = self.inner.exchange(command, data)?;
            Ok(if command == [37, 11, 147] && data[3] == 16 {
                self.reply.clone()
            } else {
                value
            })
        }
    }
    for header in [
        vec![],
        vec![1, 3, 250, 16, 8],
        vec![1, 3, 250, 24, 8],
        vec![1, 3, 250, 16, 7],
        vec![1, 2, 250, 16, 8],
    ] {
        let mut io = Malformed {
            inner: FakeExchange::plain(),
            reply: header,
        };
        let state = inspect_with_mode(&mut io, None, true).unwrap();
        assert!(state["unavailable"][0]
            .as_str()
            .unwrap()
            .ends_with("Invalid custom curve response"));
        let log = io.inner.log.lock().unwrap();
        let offsets: Vec<_> = log
            .iter()
            .filter(|e| e["command"] == json!([37, 11, 147]))
            .map(|e| e["data"][3].as_u64().unwrap())
            .collect();
        assert_eq!(offsets, [0, 8, 16]);
        assert_eq!(
            state["settings"].as_array().unwrap().last().unwrap()["id"],
            "smartTracking"
        );
    }
}

fn two_endpoints() -> (Vec<razer_hid_helper::inventory::HidNode>, Vec<String>) {
    (
        serde_json::from_value(json!([
            {"vendorId":5426,"productId":223,"interface":0,"path":"first"},
            {"vendorId":5426,"productId":223,"interface":0,"path":"second"}
        ]))
        .unwrap(),
        vec!["first".into(), "second".into()],
    )
}

#[test]
fn failed_firmware_attempt_closes_before_next_open_and_errors_keep_first_occurrence_order() {
    let (nodes, paths) = two_endpoints();
    for first_config in [
        json!({"unavailable":"firmware"}),
        json!({"shortGetter":"firmware"}),
    ] {
        let log = Arc::new(Mutex::new(Vec::new()));
        let result = inspect_target(&nodes, &paths, None, false, |node| {
            log.lock()
                .unwrap()
                .push(json!({"action":"open","path":node.path}));
            let config = if node.path == "first" {
                first_config.clone()
            } else {
                json!({})
            };
            Ok(Box::new(FakeExchange::new(config, log.clone())))
        })
        .unwrap();
        assert_eq!(result["connected"], true);
        let log = log.lock().unwrap();
        assert_eq!(
            &log[..4],
            &[
                json!({"action":"open","path":"first"}),
                json!({"action":"exchange","command":[2,0,129],"data":[]}),
                json!({"action":"close"}),
                json!({"action":"open","path":"second"})
            ]
        );
        assert_eq!(log.last().unwrap(), &json!({"action":"close"}));
        assert_eq!(log.iter().filter(|e| e["action"] == "close").count(), 2);
    }
    for (first_config,expected) in [
        (json!({"unavailable":"firmware"}),"No HID interface answered the verified firmware query: Unavailable getter"),
        (json!({"shortGetter":"firmware"}),"No HID interface answered the verified firmware query: Invalid firmware response; Unavailable getter")
    ] {
        let log=Arc::new(Mutex::new(Vec::new()));
        let error=inspect_target(&nodes,&paths,None,false,|node| {
            log.lock().unwrap().push(json!({"action":"open","path":node.path}));
            let config=if node.path=="first" {first_config.clone()} else {json!({"unavailable":"firmware"})};
            Ok(Box::new(FakeExchange::new(config,log.clone())))
        }).unwrap_err();
        assert_eq!(error.error,expected);
        assert_eq!(log.lock().unwrap().len(),6);
    }
}

#[test]
fn partial_curve_write_never_reprobes_another_endpoint_or_restores_and_closes_once() {
    let (nodes, paths) = two_endpoints();
    let log = Arc::new(Mutex::new(Vec::new()));
    let next = change("customCurve", json!(vec![1.5; 250]));
    let error = inspect_target(&nodes, &paths, Some(&next), true, |node| {
        assert_eq!(
            node.path, "first",
            "a successful firmware probe must bind the complete apply attempt"
        );
        log.lock()
            .unwrap()
            .push(json!({"action":"open","path":node.path}));
        Ok(Box::new(FakeExchange::new(
            json!({"failCurveAt":16}),
            log.clone(),
        )))
    })
    .unwrap_err();
    assert_eq!(error.error, "Simulated uncertain chunk");
    let log = log.lock().unwrap();
    assert_eq!(log.iter().filter(|e| e["action"] == "open").count(), 1);
    assert_eq!(log.iter().filter(|e| e["action"] == "close").count(), 1);
    assert_eq!(log.last().unwrap(), &json!({"action":"close"}));
    let writes: Vec<_> = log
        .iter()
        .filter(|e| e["action"] == "exchange" && e["command"][2].as_u64().unwrap() < 128)
        .collect();
    assert_eq!(writes.len(), 5);
    assert_eq!(writes[0]["command"], json!([2, 11, 16]));
    assert_eq!(writes[0]["data"], json!([1, 1]));
    assert_eq!(writes[1]["command"], json!([2, 11, 17]));
    assert_eq!(writes[1]["data"], json!([1, 3]));
    let offsets: Vec<_> = writes[2..]
        .iter()
        .map(|e| {
            assert_eq!(e["command"], json!([37, 11, 19]));
            e["data"][3].as_u64().unwrap()
        })
        .collect();
    assert_eq!(offsets, [0, 8, 16]);
    assert_eq!(log[log.len() - 2]["command"], json!([37, 11, 19]));
}

#[test]
fn smart_tracking_rejects_full_length_acknowledgement_with_one_wrong_byte() {
    struct WrongAck {
        inner: FakeExchange,
    }
    impl Exchange for WrongAck {
        fn exchange(
            &mut self,
            command: [u8; 3],
            data: &[u8],
        ) -> Result<Vec<u8>, razer_hid_helper::ApiError> {
            let reply = self.inner.exchange(command, data)?;
            Ok(if command == [4, 11, 11] {
                vec![0, 4, 1, 1]
            } else {
                reply
            })
        }
    }
    let mut io = WrongAck {
        inner: FakeExchange::plain(),
    };
    let next = change("smartTracking", json!(3));
    let error = inspect_with_mode(&mut io, Some(&next), true).unwrap_err();
    assert_eq!(error.status, 502);
    assert_eq!(
        error.error,
        "Tracking acknowledgement differs from the requested value"
    );
    let log = io.inner.log.lock().unwrap();
    assert_eq!(
        log.last().unwrap(),
        &json!({"action":"exchange","command":[4,11,11],"data":[0,4,1,2]})
    );
}
