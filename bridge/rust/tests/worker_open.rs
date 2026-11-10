use razer_hid_helper::{
    inventory::{collect_results, BindingTicket, HidNode, Inventory},
    worker_native::open_selected,
};
use serde_json::json;
fn inventory() -> (Inventory, BindingTicket) {
    let hid: Vec<HidNode> = serde_json::from_value(
        json!([{"vendorId":5426,"productId":223,"interface":0,"path":"fake-unit-a"}]),
    )
    .unwrap();
    let inventory = collect_results(Ok(hid), Ok(vec![]));
    let ticket = BindingTicket {
        device_id: inventory.devices[0].id.clone(),
        endpoint: inventory.devices[0].interfaces[0].clone(),
        epoch: 0,
    };
    (inventory, ticket)
}
#[test]
fn interface_disappearing_after_identity_recheck_keeps_public_disconnection_reason() {
    let (inventory, ticket) = inventory();
    let mut events = vec![];
    let mut opens = 0;
    let result = open_selected::<()>(
        || {
            events.push("identity-recheck");
            Ok(inventory)
        },
        &ticket,
        |endpoint| {
            assert_eq!(endpoint.path, "fake-unit-a");
            let listed: Vec<&str> = vec![];
            let Some(_) = listed.iter().find(|path| **path == endpoint.path) else {
                return Ok(None);
            };
            opens += 1;
            Ok(Some(()))
        },
    );
    let error = result.unwrap_err();
    assert_eq!(error.status, 502);
    assert!(
        !error.internal,
        "known disappearing interface must remain public"
    );
    assert_eq!(
        error.public_message(),
        "Selected device is no longer attached"
    );
    assert_eq!(events, ["identity-recheck"]);
    assert_eq!(opens, 0);
}
#[test]
fn os_open_errors_stay_internal_and_failed_identity_never_opens() {
    let (inventory, ticket) = inventory();
    let mut opens = 0;
    let error = open_selected::<()>(
        || Ok(inventory.clone()),
        &ticket,
        |_| {
            opens += 1;
            Err("Private HID device path: access denied".into())
        },
    )
    .unwrap_err();
    assert_eq!(opens, 1);
    assert!(error.internal);
    assert_eq!(
        error.public_message(),
        "Native transport failed; reconnect and inspect the companion console."
    );
    let error = open_selected::<()>(
        || {
            Ok(Inventory {
                devices: vec![],
                ..inventory
            })
        },
        &ticket,
        |_| {
            opens += 1;
            Ok(Some(()))
        },
    )
    .unwrap_err();
    assert_eq!(error.status, 409);
    assert!(!error.internal);
    assert_eq!(opens, 1);
}
