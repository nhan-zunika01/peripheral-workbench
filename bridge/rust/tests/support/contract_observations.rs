#[path = "adapter_fake.rs"]
mod adapter_fake;
use adapter_fake::FakeExchange;
use razer_hid_helper::{
    adapter::inspect_target,
    inventory::{collect_results, group_devices, resolve, snapshot_inventory, HidNode, PnpNode},
    Change, Exchange, ExpectedValue, JsValue,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
pub fn adapter(input: &Value) -> Value {
    let log = Arc::new(Mutex::new(vec![]));
    let devices=input.get("devices").cloned().unwrap_or(json!([{"vendorId":5426,"productId":223,"interface":0,"usagePage":1,"usage":2,"path":"fake-unit-a"}]));
    let nodes: Vec<razer_hid_helper::inventory::HidNode> = serde_json::from_value(devices).unwrap();
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
    let mut output = match result {
        Ok(result) => json!({"result":result}),
        Err(error) => json!({"error":error.error}),
    };
    output["transcript"] = json!(*log.lock().unwrap());
    output
}
pub fn inventory(input: &Value) -> Value {
    let mut hid: Vec<HidNode> = serde_json::from_value(input["hid"].clone()).unwrap();
    let mut pnp: Vec<PnpNode> =
        serde_json::from_value(input.get("pnp").cloned().unwrap_or(json!([]))).unwrap();
    let groups = group_devices(&hid, &pnp);
    let selected = input["selectedId"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| groups.first().map(|g| g.id.clone()));
    let mut transcript = vec![];
    let mut exchanges = vec![];
    let mut results = vec![];
    for action in input
        .get("actions")
        .cloned()
        .unwrap_or(json!([{"action":"snapshot"}]))
        .as_array()
        .unwrap()
    {
        if action["action"] == "detach" {
            hid.retain(|h| !action["paths"].as_array().unwrap().contains(&json!(h.path)));
            pnp = serde_json::from_value(action.get("pnp").cloned().unwrap_or(json!([]))).unwrap();
            continue;
        }
        transcript.push(json!({"action":"enumerate"}));
        let inv = collect_results(
            input["hidError"]
                .as_str()
                .map_or(Ok(hid.clone()), |e| Err(e.into())),
            input["pnpError"]
                .as_str()
                .map_or(Ok(pnp.clone()), |e| Err(e.into())),
        );
        let selection = if action["omitSelection"] == true {
            None
        } else {
            selected.as_deref()
        };
        if action["action"] == "apply" {
            let target = selected.as_deref().and_then(|id| resolve(&inv.devices, id));
            results.push(if target.is_none() {
                json!({"error":"Selected device is no longer attached","status":409})
            } else {
                json!({"error":"No verified adapter bound to this physical device","status":400})
            });
            continue;
        }
        let snapshot = snapshot_inventory(&inv, selection, |device| {
            let paths: Vec<_> = device.interfaces.iter().map(|n| n.path.clone()).collect();
            transcript.push(json!({"action":"snapshot","deviceId":device.id,"target":paths}));
            if let Some(error) = input["nativeError"].as_str() {
                return Err(error.into());
            }
            let observed = adapter(&json!({"devices":hid,"target":paths}));
            exchanges.extend(observed["transcript"].as_array().unwrap().iter().cloned());
            if let Some(error) = observed["error"].as_str() {
                Err(error.into())
            } else {
                Ok(observed["result"].clone())
            }
        });
        results.push(snapshot);
    }
    json!({"groups":groups,"selectedDeviceId":selected,"results":results,"transcript":transcript,"exchanges":exchanges})
}
