use razer_hid_helper::inventory::{group_devices, resolve, HidNode, PnpNode};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/inventory-parity.json"
    ))
    .unwrap()
}

fn nodes(case: &Value) -> (Vec<HidNode>, Vec<PnpNode>) {
    let mut pnp: Vec<PnpNode> = serde_json::from_value(
        case["input"]
            .get("pnp")
            .cloned()
            .unwrap_or(serde_json::json!([])),
    )
    .unwrap();
    // Frozen fake collector inputs represent successful lookups, including known absence.
    for node in &mut pnp {
        node.container_complete = true;
    }
    (
        serde_json::from_value(case["input"]["hid"].clone()).unwrap(),
        pnp,
    )
}

fn observe(
    guard: &mut razer_hid_helper::inventory::AttachmentGuard,
    inventory: &razer_hid_helper::inventory::Inventory,
    id: &str,
) {
    let window = guard.begin_observation();
    guard.observe(inventory, id, window).unwrap();
}

#[test]
fn frozen_groups_ids_and_selection_match_except_documented_byte_sort() {
    for case in fixture()["cases"].as_array().unwrap() {
        let (hid, pnp) = nodes(case);
        let groups = group_devices(&hid, &pnp);
        let expected = case.get("candidateExpected").unwrap_or(&case["legacy"]);
        let mut expected_groups = expected["groups"].clone();
        // Byte sorting also puts uppercase USB before lowercase headset in this PnP-only case.
        if case["id"] == "pnp-only" {
            expected_groups.as_array_mut().unwrap().reverse();
        }
        assert_eq!(
            serde_json::to_value(&groups).unwrap(),
            expected_groups,
            "{}",
            case["id"]
        );
        if case["id"] == "deterministic-sort" {
            assert_eq!(case["candidateDifference"]["locale"], "en-GB");
            assert_eq!(
                groups.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
                ["Razer A", "Razer Z", "Razer a", "Razer á"]
            );
            assert_eq!(groups[0].id, "1283ce2ccd4ad9484e24fadb");
            assert_eq!(
                case["legacy"]["selectedDeviceId"],
                "d486ce1694d0215b1681b3d1"
            );
        }
        if case["id"] == "two-identical" {
            assert_ne!(groups[0].id, groups[1].id);
            assert!(resolve(&groups[1..], &groups[0].id).is_none());
        }
    }
}

#[test]
fn collector_failures_survive_disconnection_but_adapter_unavailable_overwrites_them() {
    use razer_hid_helper::inventory::{collect_results, snapshot_inventory};
    for case in fixture()["cases"].as_array().unwrap() {
        let (hid, pnp) = nodes(case);
        let collect = |key: &str| case["input"][key].as_str().map(str::to_owned);
        let inv = collect_results(
            collect("hidError").map_or(Ok(hid), Err),
            collect("pnpError").map_or(Ok(pnp), Err),
        );
        let selected = case["input"]["selectedId"].as_str();
        let state = snapshot_inventory(&inv, selected, |_| {
            if let Some(error) = collect("nativeError") {
                Err(error)
            } else {
                Ok(serde_json::json!({"connected":true,"unavailable":[],"settings":[]}))
            }
        });
        assert_eq!(
            state["unavailable"], case["legacy"]["results"][0]["unavailable"],
            "{}",
            case["id"]
        );
    }
    let case = &fixture()["cases"][0];
    let (hid, pnp) = nodes(case);
    let inv = collect_results(Ok(hid), Ok(pnp));
    let state = snapshot_inventory(&inv, Some("missing"), |_| {
        panic!("missing selected ID must never dispatch")
    });
    assert_eq!(state["connected"], false);
    assert_eq!(state["selectedDeviceId"], "missing");
    assert!(state["devices"][0].get("interfaces").is_none());
    assert!(state["devices"][0].get("endpoints").is_none());
}

#[test]
fn observed_removal_latches_across_reconnect_and_blocks_go_and_open() {
    use razer_hid_helper::inventory::{verified_open, AttachmentGuard, Inventory};
    let (hid, pnp) = nodes(&fixture()["cases"][3]);
    let devices = group_devices(&hid, &pnp);
    let a = &devices[0];
    let inv = Inventory {
        devices: devices.clone(),
        warnings: vec![],
        identity_complete: true,
    };
    let (mut guard, signal) = AttachmentGuard::new();
    observe(&mut guard, &inv, &a.id);
    let ticket = guard.prepare(a, &a.interfaces[0].path).unwrap();
    // Identical observable inputs without an event cannot reveal replacement.
    observe(&mut guard, &inv, &a.id);
    assert!(guard.check_dispatch(&ticket).is_ok());
    signal.removed(&a.interfaces[0].path.to_uppercase());
    observe(&mut guard, &inv, &a.id);
    assert_eq!(guard.check_dispatch(&ticket).unwrap_err().status, 409);
    let mut schemas = serde_json::json!({"settings":[{"id":"dpi","writable":true}]});
    guard.protect_snapshot(&a.id, &mut schemas);
    assert_eq!(schemas["settings"][0]["writable"], false);
    assert!(guard.prepare(a, &a.interfaces[0].path).is_err());
    let mut opens = 0;
    let changed = Inventory {
        devices: vec![devices[1].clone()],
        warnings: vec![],
        identity_complete: true,
    };
    assert!(verified_open(
        || Ok(changed),
        &ticket,
        |_| {
            opens += 1;
            Ok(())
        }
    )
    .is_err());
    assert_eq!(opens, 0);
    let (mut restarted, _) = AttachmentGuard::new();
    observe(&mut restarted, &inv, &a.id);
    assert!(restarted.prepare(a, &a.interfaces[0].path).is_ok());
    let fresh = restarted.prepare(a, &a.interfaces[0].path).unwrap();
    assert!(verified_open(
        || Ok(inv),
        &fresh,
        |_| {
            opens += 1;
            Ok(())
        }
    )
    .is_ok());
    assert_eq!(opens, 1);
}

#[test]
fn removal_between_enumeration_and_first_observation_cannot_be_lost() {
    use razer_hid_helper::inventory::{AttachmentGuard, Inventory};
    let (hid, pnp) = nodes(&fixture()["cases"][0]);
    let inv = Inventory {
        devices: group_devices(&hid, &pnp),
        warnings: vec![],
        identity_complete: true,
    };
    let selected = &inv.devices[0];
    let (mut guard, signal) = AttachmentGuard::new();
    let window = guard.begin_observation();
    signal.removed(&selected.interfaces[0].path);
    guard.observe(&inv, &selected.id, window).unwrap();
    assert!(
        guard
            .prepare(selected, &selected.interfaces[0].path)
            .is_err(),
        "queued removal before first observe must latch"
    );
}

#[test]
fn same_container_with_changed_endpoint_cannot_acquire_a_new_write_ticket() {
    use razer_hid_helper::inventory::{AttachmentGuard, Inventory};
    let (hid, pnp) = nodes(&fixture()["cases"][0]);
    let original = Inventory {
        devices: group_devices(&hid, &pnp),
        warnings: vec![],
        identity_complete: true,
    };
    let a = original
        .devices
        .iter()
        .find(|d| d.container_id.is_some() && d.supported)
        .unwrap();
    for change in ["path", "pid", "interface"] {
        let mut changed = a.clone();
        match change {
            "path" => changed.interfaces[0].path.push_str("replacement"),
            "pid" => changed.interfaces[0].product_id = 0xde,
            _ => changed.interfaces[0].interface_number = 1,
        }
        let (mut guard, _) = AttachmentGuard::new();
        observe(&mut guard, &original, &a.id);
        observe(
            &mut guard,
            &Inventory {
                devices: vec![changed.clone()],
                warnings: vec![],
                identity_complete: true,
            },
            &a.id,
        );
        assert!(
            guard
                .prepare(&changed, &changed.interfaces[0].path)
                .is_err(),
            "changed {change} retained a writable attachment"
        );
    }
}

#[test]
fn inventory_session_registers_before_collection_and_unregisters_after_drain() {
    use razer_hid_helper::inventory::Inventory;
    use razer_hid_helper::windows_inventory::InventorySession;
    use std::{cell::RefCell, rc::Rc};
    struct Listener(Rc<RefCell<Vec<&'static str>>>);
    impl Drop for Listener {
        fn drop(&mut self) {
            self.0.borrow_mut().push("unregister");
        }
    }
    let events = Rc::new(RefCell::new(vec![]));
    let result = InventorySession::<Listener>::start(
        |_| Err("registration denied".into()),
        || {
            panic!("registration failure must stop startup before HID");
        },
    );
    assert!(result.is_err());
    let (session, _, _) = InventorySession::start(
        |signal| {
            events.borrow_mut().push("register");
            signal.removed("HID-PATH");
            Ok(Listener(events.clone()))
        },
        || {
            events.borrow_mut().push("enumerate");
            Ok(Inventory {
                devices: vec![],
                warnings: vec![],
                identity_complete: true,
            })
        },
    )
    .unwrap();
    assert_eq!(&*events.borrow(), &["register", "enumerate"]);
    session.shutdown(|| events.borrow_mut().push("drain"));
    assert_eq!(
        &*events.borrow(),
        &["register", "enumerate", "drain", "unregister"]
    );
}

#[test]
fn native_property_buffers_and_registry_precedence_are_typed_and_bounded() {
    use razer_hid_helper::windows_inventory::{
        decode_guid, decode_string, pnp_node, read_sized, BufferError,
    };
    let mut calls = 0;
    let result = read_sized(|buffer| {
        calls += 1;
        if buffer.len() < 6 {
            return Err(BufferError::MoreData(6));
        }
        buffer[..6].copy_from_slice(&[65, 0, 66, 0, 0, 0]);
        Ok((6, 1))
    })
    .unwrap()
    .unwrap();
    assert_eq!(calls, 2);
    assert_eq!(decode_string(result.1, &result.0, 1).unwrap(), "AB");
    assert!(decode_string(7, &result.0, 1).is_err());
    assert!(decode_string(1, &[65], 1).is_err());
    assert!(decode_string(1, &[65, 0], 1).is_err());
    assert!(read_sized(|_| Err(BufferError::MoreData(1_048_577))).is_err());
    let node = pnp_node(
        "HID\\VID_1532\\EXACT",
        "Mouse",
        "Mouse",
        Ok(Some("{ABCD}".into())),
        || panic!("registry must win"),
    )
    .unwrap()
    .unwrap();
    assert_eq!(node.container_id, "{ABCD}");
    let fallback = pnp_node(
        "USB\\VID&00021532\\A",
        "",
        "USB",
        Err("denied".into()),
        || Ok(Some("1234".into())),
    )
    .unwrap()
    .unwrap();
    assert_eq!(fallback.container_id, "1234");
    assert!(
        pnp_node("AUDIO\\HEADSET", "Razer audio", "Audio", Ok(None), || Ok(
            None
        ))
        .unwrap()
        .is_some()
    );
    assert!(pnp_node("USB\\OTHER", "Other", "USB", Ok(None), || panic!(
        "filtered node"
    ))
    .unwrap()
    .is_none());
    let guid = [
        0x33, 0x22, 0x11, 0, 0x55, 0x44, 0x77, 0x66, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
    ];
    assert_eq!(
        decode_guid(13, &guid).unwrap(),
        "00112233-4455-6677-8899-aabbccddeeff"
    );
    assert!(decode_guid(18, &guid).is_err());
    assert!(decode_guid(13, &guid[..15]).is_err());
}

#[test]
fn prepare_rechecks_original_binding_even_if_a_caller_misses_observe() {
    use razer_hid_helper::inventory::{AttachmentGuard, Inventory};
    let (hid, pnp) = nodes(&fixture()["cases"][0]);
    let inv = Inventory {
        devices: group_devices(&hid, &pnp),
        warnings: vec![],
        identity_complete: true,
    };
    let a = &inv.devices[0];
    let (mut guard, _) = AttachmentGuard::new();
    observe(&mut guard, &inv, &a.id);
    let mut changed = a.clone();
    changed.interfaces[0].path.push_str("replacement");
    assert!(guard
        .prepare(&changed, &changed.interfaces[0].path)
        .is_err());
}

#[test]
fn optional_container_access_denied_keeps_the_present_pnp_endpoint() {
    use razer_hid_helper::windows_inventory::pnp_node;
    let result = pnp_node(
        "HID\\VID_1532\\A",
        "Razer mouse",
        "Mouse",
        Err("registry access denied".into()),
        || Err("property access denied".into()),
    );
    assert!(
        result.is_ok(),
        "optional ContainerID access failure must not discard the PnP inventory"
    );
    let node = result.unwrap().unwrap();
    assert_eq!(node.container_id, "");
    assert_eq!(
        group_devices(&[], &[node])[0].id,
        "c62733ccbba9094e5e197211"
    );
}

#[test]
fn null_container_id_uses_endpoint_identity_instead_of_rejecting_inventory() {
    let node = serde_json::from_value::<PnpNode>(
        serde_json::json!({"instanceId":"HID\\VID_1532\\A","containerId":null,"name":"Razer mouse"}),
    );
    assert!(
        node.is_ok(),
        "null ContainerID is a missing identity, not a failed inventory"
    );
    let groups = group_devices(&[], &[node.unwrap()]);
    assert_eq!(groups[0].id, "c62733ccbba9094e5e197211");
    assert_eq!(groups[0].container_id, None);
}

#[path = "support/inventory_edges.rs"]
mod inventory_edges;
