use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const UNSUPPORTED: &str = "Detected by Windows; this product has no verified settings adapter. No device commands will be sent.";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HidNode {
    pub path: String,
    pub vendor_id: u16,
    pub product_id: u16,
    #[serde(rename = "interface")]
    pub interface_number: i32,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl HidNode {
    pub fn supported(&self) -> bool {
        self.vendor_id == 0x1532
            && [0xde, 0xdf].contains(&self.product_id)
            && self.interface_number == 0
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PnpNode {
    pub instance_id: String,
    #[serde(default, deserialize_with = "nullable_string")]
    pub container_id: String,
    #[serde(skip)]
    pub container_complete: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub container_id: Option<String>,
    pub interfaces: Vec<HidNode>,
    pub endpoints: Vec<PnpNode>,
    pub supported: bool,
    pub reason: Option<String>,
}

fn nullable_string<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    Option::<String>::deserialize(input).map(Option::unwrap_or_default)
}

pub fn normalize_path(path: &str) -> String {
    let lower = path.to_lowercase();
    let instance = lower
        .strip_prefix(r"\\?\")
        .unwrap_or(&lower)
        .replace('#', "\\");
    instance.split(r"\{").next().unwrap_or("").into()
}

fn add_group<'a>(
    groups: &'a mut Vec<Device>,
    instance: &str,
    container: &str,
    extra: &Map<String, Value>,
) -> &'a mut Device {
    let container = if container.trim_start_matches('{').starts_with("00000000-") {
        ""
    } else {
        container
    };
    let identity = if container.is_empty() {
        format!("endpoint:{instance}")
    } else {
        format!("container:{container}")
    };
    let id = format!("{:x}", Sha256::digest(identity.as_bytes()))[..24].to_owned();
    let index = groups.iter().position(|g| g.id == id).unwrap_or_else(|| {
        groups.push(Device {
            id,
            name: String::new(),
            container_id: (!container.is_empty()).then(|| container.into()),
            interfaces: vec![],
            endpoints: vec![],
            supported: false,
            reason: None,
        });
        groups.len() - 1
    });
    let group = &mut groups[index];
    let name = extra
        .get("product")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| extra.get("name").and_then(Value::as_str));
    if let Some(name) = name.filter(|s| !s.is_empty()) {
        if group.name.is_empty() || name.to_lowercase().contains("razer") {
            group.name = name.into();
        }
    }
    group
}

pub fn group_devices(hid: &[HidNode], pnp: &[PnpNode]) -> Vec<Device> {
    let nodes: Vec<_> = pnp
        .iter()
        .cloned()
        .map(|mut node| {
            node.instance_id = node.instance_id.to_lowercase();
            node.container_id = node.container_id.to_lowercase();
            node.extra.insert("source".into(), "pnp".into());
            node
        })
        .collect();
    let mut groups = vec![];
    for node in &nodes {
        add_group(
            &mut groups,
            &node.instance_id,
            &node.container_id,
            &node.extra,
        )
        .endpoints
        .push(node.clone());
    }
    for endpoint in hid.iter().filter(|h| h.vendor_id == 0x1532) {
        let instance = normalize_path(&endpoint.path);
        let container = nodes
            .iter()
            .find(|n| n.instance_id == instance)
            .map(|n| n.container_id.as_str())
            .unwrap_or("");
        let mut endpoint = endpoint.clone();
        endpoint.extra.insert("source".into(), "hid".into());
        add_group(&mut groups, &instance, container, &endpoint.extra)
            .interfaces
            .push(endpoint);
    }
    for group in &mut groups {
        if group.name.is_empty() {
            group.name = "Razer device".into();
        }
        group.supported = group.interfaces.iter().any(HidNode::supported);
        group.reason = (!group.supported).then(|| UNSUPPORTED.into());
    }
    groups.sort_by(|a, b| {
        b.supported
            .cmp(&a.supported)
            .then(a.name.as_bytes().cmp(b.name.as_bytes()))
            .then(a.id.cmp(&b.id))
    });
    groups
}

pub fn resolve<'a>(devices: &'a [Device], selected_id: &str) -> Option<&'a Device> {
    devices.iter().find(|device| device.id == selected_id)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Inventory {
    pub devices: Vec<Device>,
    pub warnings: Vec<String>,
    #[serde(default)]
    pub identity_complete: bool,
}

pub trait InventorySource {
    fn collect(&mut self) -> Result<Inventory, String>;
}

pub fn collect_results(
    hid: Result<Vec<HidNode>, String>,
    pnp: Result<Vec<PnpNode>, String>,
) -> Inventory {
    let identity_complete = hid.is_ok()
        && pnp
            .as_ref()
            .is_ok_and(|nodes| nodes.iter().all(|node| node.container_complete));
    let mut warnings = vec![];
    let mut take = |result: Result<Vec<_>, String>| {
        result.unwrap_or_else(|error| {
            warnings.push(error);
            vec![]
        })
    };
    let hid = take(hid);
    let pnp = pnp.unwrap_or_else(|error| {
        warnings.push(error);
        vec![]
    });
    Inventory {
        devices: group_devices(&hid, &pnp),
        warnings,
        identity_complete,
    }
}

impl Device {
    pub fn public(&self) -> Value {
        serde_json::json!({"id":self.id,"name":self.name,"containerId":self.container_id,
            "supported":self.supported,"reason":self.reason,"interfaceCount":self.interfaces.len()+self.endpoints.len()})
    }
}

pub fn snapshot_inventory(
    inventory: &Inventory,
    selected_id: Option<&str>,
    adapter: impl FnOnce(&Device) -> Result<Value, String>,
) -> Value {
    let selected = match selected_id {
        Some(id) => resolve(&inventory.devices, id),
        None => inventory.devices.first(),
    };
    let selected_id = selected_id
        .map(str::to_owned)
        .or_else(|| selected.map(|d| d.id.clone()));
    let devices: Vec<_> = inventory.devices.iter().map(Device::public).collect();
    let mut common = serde_json::json!({"devices":devices,"selectedDeviceId":selected_id,"settings":[],"unavailable":inventory.warnings});
    let Some(selected) = selected else {
        common["connected"] = false.into();
        common["message"] = if selected_id.is_some() {
            "Selected device is no longer attached. Reconnect it or choose another device."
        } else {
            "No attached Razer devices found."
        }
        .into();
        return common;
    };
    let result = if selected.supported {
        adapter(selected)
    } else {
        Err(selected.reason.clone().unwrap_or_default())
    };
    match result {
        Ok(Value::Object(fields)) => {
            for (key, value) in fields {
                if key != "devices" && key != "selectedDeviceId" {
                    common[key] = value;
                }
            }
        }
        result => {
            common["connected"] = false.into();
            common["model"] = selected.name.clone().into();
            common["message"] = result
                .err()
                .unwrap_or_else(|| "Invalid adapter snapshot".into())
                .into();
        }
    }
    common
}

#[path = "attachment.rs"]
mod attachment;
pub use attachment::*;
