use super::*;

#[test]
fn removal_between_jobs_blocks_the_next_go_and_after_dispatch_marks_uncertainty() {
    use razer_hid_helper::inventory::{AttachmentGuard, Inventory};
    let (hid, pnp) = nodes(&fixture()["cases"][3]);
    let inv = Inventory {
        devices: group_devices(&hid, &pnp),
        warnings: vec![],
        identity_complete: true,
    };
    let a = &inv.devices[0];
    let (mut guard, signal) = AttachmentGuard::new();
    observe(&mut guard, &inv, &a.id);
    let ticket = guard.prepare(a, &a.interfaces[0].path).unwrap();
    let mut dispatched_writes = 0;
    if guard.check_dispatch(&ticket).is_ok() {
        dispatched_writes += 1;
    }
    signal.removed(&a.interfaces[0].path);
    let outcome_unknown = guard.check_dispatch(&ticket).is_err();
    assert!(
        outcome_unknown,
        "an event after GO cannot be reported as a safe attachment"
    );
    observe(&mut guard, &inv, &a.id);
    let mut next_writes = 0;
    if guard.prepare(a, &a.interfaces[0].path).is_ok() {
        next_writes += 1;
    }
    assert_eq!((dispatched_writes, next_writes), (1, 0));
    let (mut missing_guard, _) = AttachmentGuard::new();
    observe(&mut missing_guard, &inv, &a.id);
    observe(
        &mut missing_guard,
        &Inventory {
            devices: vec![],
            warnings: vec![],
            identity_complete: true,
        },
        &a.id,
    );
    observe(&mut missing_guard, &inv, &a.id);
    assert!(missing_guard.prepare(a, &a.interfaces[0].path).is_err());
}

#[test]
fn an_old_unselected_removal_does_not_poison_a_fresh_selection() {
    use razer_hid_helper::inventory::{AttachmentGuard, Inventory};
    let (hid, pnp) = nodes(&fixture()["cases"][3]);
    let inv = Inventory {
        devices: group_devices(&hid, &pnp),
        warnings: vec![],
        identity_complete: true,
    };
    let (a, b) = (&inv.devices[0], &inv.devices[1]);
    let (mut guard, signal) = AttachmentGuard::new();
    observe(&mut guard, &inv, &a.id);
    signal.removed(&b.interfaces[0].path);
    // B reconnects; its new enumeration happens after the old removal.
    observe(&mut guard, &inv, &b.id);
    assert!(
        guard.prepare(b, &b.interfaces[0].path).is_ok(),
        "B was never selected before its old removal"
    );
}

#[test]
fn whole_pnp_failure_cannot_authorize_an_endpoint_identity_open() {
    use razer_hid_helper::inventory::{collect_results, verified_open, AttachmentGuard};
    let (hid, _) = nodes(&fixture()["cases"][1]);
    let baseline = collect_results(Ok(hid.clone()), Ok(vec![]));
    let a = &baseline.devices[0];
    let (mut guard, _) = AttachmentGuard::new();
    observe(&mut guard, &baseline, &a.id);
    let ticket = guard.prepare(a, &a.interfaces[0].path).unwrap();
    let replacement: PnpNode = serde_json::from_value(serde_json::json!({"instanceId":"HID\\VID_1532&PID_00DF\\UNIT-A","containerId":"{replacement}"})).unwrap();
    let changed = collect_results(Ok(hid.clone()), Ok(vec![replacement]));
    assert_ne!(changed.devices[0].id, a.id);
    let failed = collect_results(Ok(hid), Err("PnP collector failed".into()));
    let mut opens = 0;
    let result = verified_open(
        || Ok(failed),
        &ticket,
        |_| {
            opens += 1;
            Ok(())
        },
    );
    assert!(
        result.is_err(),
        "a failed PnP identity check must not authorize open"
    );
    assert_eq!(opens, 0);
}

#[test]
fn failed_container_lookups_keep_display_identity_but_cannot_authorize_open() {
    use razer_hid_helper::inventory::{collect_results, verified_open, AttachmentGuard};
    use razer_hid_helper::windows_inventory::pnp_node;
    let (hid, _) = nodes(&fixture()["cases"][1]);
    let baseline = collect_results(Ok(hid.clone()), Ok(vec![]));
    let a = &baseline.devices[0];
    let (mut guard, _) = AttachmentGuard::new();
    observe(&mut guard, &baseline, &a.id);
    let ticket = guard.prepare(a, &a.interfaces[0].path).unwrap();
    let unknown = pnp_node(
        "HID\\VID_1532&PID_00DF\\UNIT-A",
        "Razer mouse",
        "Mouse",
        Err("denied".into()),
        || Err("denied".into()),
    )
    .unwrap()
    .unwrap();
    let failed = collect_results(Ok(hid), Ok(vec![unknown]));
    assert!(!failed.identity_complete);
    let failed: razer_hid_helper::inventory::Inventory =
        serde_json::from_value(serde_json::to_value(failed).unwrap()).unwrap();
    assert_eq!(failed.devices[0].id, a.id);
    assert!(
        failed.warnings.is_empty(),
        "optional lookup errors do not change legacy public warnings"
    );
    let mut opens = 0;
    let result = verified_open(
        || Ok(failed),
        &ticket,
        |_| {
            opens += 1;
            Ok(())
        },
    );
    assert!(
        result.is_err(),
        "both failed container lookups leave identity incomplete"
    );
    assert_eq!(opens, 0);
}

#[test]
fn transient_collection_failure_denies_writes_without_latching_a_confirmed_absence() {
    use razer_hid_helper::inventory::{collect_results, AttachmentGuard};
    let (hid, pnp) = nodes(&fixture()["cases"][1]);
    let baseline = collect_results(Ok(hid), Ok(pnp.clone()));
    let a = &baseline.devices[0];
    let (mut guard, _) = AttachmentGuard::new();
    observe(&mut guard, &baseline, &a.id);
    let failed = collect_results(Err("HID collector timeout".into()), Ok(pnp));
    let window = guard.begin_observation();
    let _ = guard.observe(&failed, &a.id, window);
    assert!(guard.prepare(a, &a.interfaces[0].path).is_err());
    observe(&mut guard, &baseline, &a.id);
    assert!(
        guard.prepare(a, &a.interfaces[0].path).is_ok(),
        "a failed collector did not confirm removal"
    );
}

#[test]
fn private_identity_evidence_round_trips_and_missing_evidence_is_untrusted() {
    use razer_hid_helper::inventory::{collect_results, verified_open, AttachmentGuard, Inventory};
    let (hid, pnp) = nodes(&fixture()["cases"][1]);
    let baseline = collect_results(Ok(hid.clone()), Ok(pnp));
    assert!(baseline.identity_complete);
    let bytes = serde_json::to_vec(&baseline).unwrap();
    let restored: Inventory = serde_json::from_slice(&bytes).unwrap();
    assert!(restored.identity_complete);
    let a = &restored.devices[0];
    let (mut guard, _) = AttachmentGuard::new();
    observe(&mut guard, &restored, &a.id);
    let ticket = guard.prepare(a, &a.interfaces[0].path).unwrap();
    assert!(verified_open(|| Ok(restored.clone()), &ticket, |_| Ok(())).is_ok());
    let failed = collect_results(Ok(hid), Err("PnP timeout".into()));
    let failed: Inventory = serde_json::from_value(serde_json::to_value(failed).unwrap()).unwrap();
    assert!(!failed.identity_complete);
    assert!(verified_open::<()>(
        || Ok(failed),
        &ticket,
        |_| panic!("incomplete IPC inventory must not open")
    )
    .is_err());
    let mut missing = serde_json::to_value(&restored).unwrap();
    missing.as_object_mut().unwrap().remove("identity_complete");
    let missing: Inventory = serde_json::from_value(missing).unwrap();
    assert!(!missing.identity_complete);
    assert!(verified_open::<()>(
        || Ok(missing),
        &ticket,
        |_| panic!("missing IPC evidence must not open")
    )
    .is_err());
}

#[test]
fn observation_tokens_are_owned_by_one_guard_and_only_the_latest_window_is_valid() {
    use razer_hid_helper::inventory::{collect_results, AttachmentGuard};
    let (hid, pnp) = nodes(&fixture()["cases"][1]);
    let baseline = collect_results(Ok(hid), Ok(pnp));
    let a = &baseline.devices[0];
    let (mut guard, _) = AttachmentGuard::new();
    let (mut other, _) = AttachmentGuard::new();
    let foreign = other.begin_observation();
    assert!(guard.observe(&baseline, &a.id, foreign).is_err());
    assert!(guard.prepare(a, &a.interfaces[0].path).is_err());
    let superseded = guard.begin_observation();
    let current = guard.begin_observation();
    assert!(guard.observe(&baseline, &a.id, superseded).is_err());
    assert!(guard.prepare(a, &a.interfaces[0].path).is_err());
    guard.observe(&baseline, &a.id, current).unwrap();
    assert!(guard.prepare(a, &a.interfaces[0].path).is_ok());
}

#[test]
fn complete_browser_snapshots_match_frozen_contract_including_omissions() {
    use razer_hid_helper::inventory::{collect_results, snapshot_inventory};
    let adapter_fixture: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/adapter-parity.json"
    ))
    .unwrap();
    let adapter = &adapter_fixture["cases"][0]["legacy"]["result"];
    assert!(adapter["connected"].as_bool().unwrap());
    for case in fixture()["cases"].as_array().unwrap() {
        let (mut hid, mut pnp) = nodes(case);
        let expected = case.get("candidateExpected").unwrap_or(&case["legacy"]);
        let selected = case["legacy"]["selectedDeviceId"].as_str();
        let defaults = serde_json::json!([{"action":"snapshot"}]);
        let actions = case["input"]
            .get("actions")
            .unwrap_or(&defaults)
            .as_array()
            .unwrap();
        let mut result_index = 0;
        for action in actions {
            if action["action"] == "detach" {
                hid.retain(|h| {
                    !action["paths"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|path| path == &h.path)
                });
                pnp = serde_json::from_value(
                    action.get("pnp").cloned().unwrap_or(serde_json::json!([])),
                )
                .unwrap();
                continue;
            }
            if action["action"] == "apply" {
                result_index += 1;
                continue;
            }
            let hid_result = match case["input"]["hidError"].as_str() {
                Some(error) => Err(error.into()),
                None => Ok(hid.clone()),
            };
            let pnp_result = match case["input"]["pnpError"].as_str() {
                Some(error) => Err(error.into()),
                None => Ok(pnp.clone()),
            };
            let inventory = collect_results(hid_result, pnp_result);
            let selection = if action["omitSelection"] == true {
                None
            } else {
                selected
            };
            let state = snapshot_inventory(&inventory, selection, |_| {
                if let Some(error) = case["input"]["nativeError"].as_str() {
                    Err(error.into())
                } else {
                    Ok(adapter.clone())
                }
            });
            let mut expected_state = expected["results"][result_index].clone();
            if case["id"] == "pnp-only" {
                expected_state["devices"].as_array_mut().unwrap().reverse();
            }
            assert_eq!(
                state, expected_state,
                "complete snapshot {} result {}",
                case["id"], result_index
            );
            result_index += 1;
        }
    }
}

fn registry_error_blocks_open(fallback: Option<&str>) {
    use razer_hid_helper::inventory::{collect_results, verified_open, AttachmentGuard};
    use razer_hid_helper::windows_inventory::pnp_node;
    let (hid, _) = nodes(&fixture()["cases"][1]);
    let value = fallback.map(str::to_owned);
    let instance = "HID\\VID_1532&PID_00DF\\UNIT-A";
    let node = pnp_node(instance, "Razer mouse", "Mouse", Ok(value.clone()), || {
        Ok(value.clone())
    })
    .unwrap()
    .unwrap();
    let baseline = collect_results(Ok(hid.clone()), Ok(vec![node]));
    let a = &baseline.devices[0];
    let (mut guard, _) = AttachmentGuard::new();
    observe(&mut guard, &baseline, &a.id);
    let ticket = guard.prepare(a, &a.interfaces[0].path).unwrap();
    let unknown = pnp_node(
        instance,
        "Razer mouse",
        "Mouse",
        Err("registry denied".into()),
        || Ok(value.clone()),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        unknown.container_id,
        value.unwrap_or_default(),
        "legacy display fallback remains intact"
    );
    let failed = collect_results(Ok(hid), Ok(vec![unknown]));
    assert_eq!(failed.devices[0].id, a.id);
    assert!(failed.warnings.is_empty());
    let mut opens = 0;
    let result = verified_open(
        || Ok(failed),
        &ticket,
        |_| {
            opens += 1;
            Ok(())
        },
    );
    assert!(
        result.is_err(),
        "a fallback cannot prove the preferred registry value after its read failed"
    );
    assert_eq!(opens, 0);
}

#[test]
fn failed_preferred_registry_lookup_with_absent_fallback_never_opens() {
    registry_error_blocks_open(None);
}

#[test]
fn failed_preferred_registry_lookup_with_present_fallback_never_opens() {
    registry_error_blocks_open(Some("{abcd}"));
}
