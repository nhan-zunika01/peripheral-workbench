pub use crate::api_error::ApiError;
use crate::{inventory::HidNode, validate_value, JsValue};
use serde::{ser::SerializeMap, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Default)]
pub enum ExpectedValue {
    #[default]
    Missing,
    Present(JsValue),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    pub device_id: String,
    pub id: String,
    pub value: JsValue,
    pub expected_value: ExpectedValue,
}
impl Change {
    pub fn parse(bytes: &[u8]) -> Result<Self, ApiError> {
        Self::try_from(JsValue::parse(bytes)?)
    }
}
impl TryFrom<JsValue> for Change {
    type Error = ApiError;
    fn try_from(value: JsValue) -> Result<Self, ApiError> {
        let invalid = || {
            ApiError::new(
                400,
                "Expected deviceId, id, value and optional expectedValue",
            )
        };
        let JsValue::Object(mut fields) = value else {
            return Err(invalid());
        };
        if !fields
            .keys()
            .all(|k| ["deviceId", "id", "value", "expectedValue"].contains(&k.as_str()))
        {
            return Err(invalid());
        }
        let Some(JsValue::String(device_id)) = fields.remove("deviceId") else {
            return Err(invalid());
        };
        if device_id.len() != 24
            || !device_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid());
        }
        let Some(JsValue::String(id)) = fields.remove("id") else {
            return Err(invalid());
        };
        let value = fields.remove("value").ok_or_else(invalid)?;
        let expected_value = fields
            .remove("expectedValue")
            .map(ExpectedValue::Present)
            .unwrap_or_default();
        Ok(Self {
            device_id,
            id,
            value,
            expected_value,
        })
    }
}
impl<'de> Deserialize<'de> for Change {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::try_from(JsValue::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}
impl Serialize for Change {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(None)?;
        map.serialize_entry("deviceId", &self.device_id)?;
        map.serialize_entry("id", &self.id)?;
        map.serialize_entry("value", &self.value)?;
        if let ExpectedValue::Present(value) = &self.expected_value {
            map.serialize_entry("expectedValue", value)?
        }
        map.end()
    }
}
pub trait Exchange {
    fn exchange(&mut self, command: [u8; 3], data: &[u8]) -> Result<Vec<u8>, ApiError>;
}
const MODEL: &str = "Razer Viper V3 Pro SE";

pub fn inspect(io: &mut dyn Exchange, change: Option<&Change>) -> Result<Value, ApiError> {
    inspect_with_mode(io, change, false)
}
pub fn inspect_with_mode(
    io: &mut dyn Exchange,
    change: Option<&Change>,
    allow_writes: bool,
) -> Result<Value, ApiError> {
    reject_read_only(change, allow_writes)?;
    let firmware = probe(io).map_err(|e| {
        if e.internal {
            return e;
        }
        ApiError::new(
            502,
            format!(
                "No HID interface answered the verified firmware query: {}",
                e.error
            ),
        )
    })?;
    inspect_verified(io, &firmware, change, allow_writes)
}
fn reject_read_only(change: Option<&Change>, allow_writes: bool) -> Result<(), ApiError> {
    if change.is_some() && !allow_writes {
        Err(ApiError::new(400, "Setting is not writable"))
    } else {
        Ok(())
    }
}
pub fn inspect_target<F>(
    nodes: &[HidNode],
    paths: &[String],
    change: Option<&Change>,
    allow_writes: bool,
    mut open: F,
) -> Result<Value, ApiError>
where
    F: FnMut(&HidNode) -> Result<Box<dyn Exchange>, ApiError>,
{
    reject_read_only(change, allow_writes)?;
    let selected: Vec<_> = nodes
        .iter()
        .filter(|n| {
            paths.contains(&n.path) && n.vendor_id == 0x1532 && [0xde, 0xdf].contains(&n.product_id)
        })
        .collect();
    if selected.is_empty() {
        return Err(ApiError::new(502, "Selected device is no longer attached"));
    }
    let mut candidates: Vec<_> = selected
        .into_iter()
        .filter(|n| n.interface_number == 0)
        .collect();
    candidates.sort_by_key(|n| {
        std::cmp::Reverse(
            n.extra.get("usagePage").and_then(Value::as_f64) == Some(1.)
                && n.extra.get("usage").and_then(Value::as_f64) == Some(2.),
        )
    });
    if candidates.is_empty() {
        return Ok(
            json!({"connected":false,"model":MODEL,"message":"No supported mouse on HID interface 0.","settings":[]}),
        );
    }
    let mut errors = Vec::new();
    let mut internal_error = None;
    for candidate in candidates {
        let attempt =
            open(candidate).and_then(|mut io| probe(io.as_mut()).map(|firmware| (io, firmware)));
        match attempt {
            Ok((mut io, firmware)) => {
                return inspect_verified(io.as_mut(), &firmware, change, allow_writes)
            }
            Err(e) => {
                if e.internal {
                    internal_error = Some(e.clone());
                }
                if !errors.contains(&e.error) {
                    errors.push(e.error)
                }
            }
        }
    }
    if let Some(error) = internal_error {
        return Err(error);
    }
    Err(ApiError::new(
        502,
        format!(
            "No HID interface answered the verified firmware query: {}",
            errors.join("; ")
        ),
    ))
}
fn probe(io: &mut dyn Exchange) -> Result<Vec<u8>, ApiError> {
    let firmware = io.exchange([2, 0, 129], &[])?;
    if firmware.len() < 2 {
        return Err(ApiError::new(502, "Invalid firmware response"));
    }
    Ok(firmware)
}
fn inspect_verified(
    io: &mut dyn Exchange,
    firmware: &[u8],
    change: Option<&Change>,
    allow_writes: bool,
) -> Result<Value, ApiError> {
    let mut settings = vec![
        json!({"id":"firmware","label":"Firmware","type":"string","value":format!("{}.{}",firmware[0],firmware[1]),"writable":false}),
    ];
    let mut unavailable = Vec::new();
    let mut stage_ids = Vec::new();
    for mut schema in crate::schema::catalog() {
        let id = schema["id"].as_str().unwrap().to_owned();
        let dependency = match id.as_str() {
            "customCurve" => Some("dynamicMode"),
            "smartTracking" => Some("calibrationState"),
            _ => None,
        };
        if dependency
            .map(|d| !settings.iter().any(|s| s["id"] == d))
            .unwrap_or(false)
        {
            continue;
        }
        match get(io, &id, &mut stage_ids) {
            Ok(value) => {
                schema["value"] = value;
                if !allow_writes {
                    schema["writable"] = false.into()
                }
                settings.push(schema);
            }
            Err(e) => unavailable.push(format!(
                "{}: {}",
                schema["label"].as_str().unwrap(),
                e.public_message()
            )),
        }
    }
    if let Some(change) = change {
        let schema = settings
            .iter()
            .find(|s| s["id"] == change.id && s["writable"] == true)
            .ok_or_else(|| ApiError::new(502, "Native setting unavailable"))?;
        validate_value(schema, &change.value)?;
        return apply(io, change, &stage_ids);
    }
    Ok(
        json!({"connected":true,"model":MODEL,"message":format!("{} native settings read. Close Synapse while using this companion to prevent concurrent device access.",settings.len()),"settings":settings,"unavailable":unavailable}),
    )
}
fn be16(data: &[u8], offset: usize) -> u16 {
    u16::from_be_bytes([data[offset], data[offset + 1]])
}
fn getter(id: &str) -> ([u8; 3], Vec<u8>, usize) {
    match id {
        "dpi" => ([7, 4, 133], vec![0], 5),
        "dpiStages" => ([80, 4, 134], vec![0], 3),
        "polling" => ([1, 0, 133], vec![], 1),
        "pollingWired" => ([2, 0, 192], vec![0], 2),
        "pollingWireless" => ([2, 0, 192], vec![1], 2),
        "battery" => ([2, 7, 128], vec![0], 2),
        "sleep" => ([2, 7, 131], vec![], 2),
        "lowPower" => ([1, 7, 129], vec![], 1),
        "rotation" => ([3, 11, 148], vec![1], 3),
        "dynamicState" => ([2, 11, 144], vec![1], 2),
        "dynamicMode" => ([2, 11, 145], vec![1], 2),
        "calibrationState" => ([3, 11, 131], vec![0, 4], 3),
        "asymmetricTracking" => ([10, 11, 133], vec![0, 4], 4),
        _ => unreachable!(),
    }
}
fn get(io: &mut dyn Exchange, id: &str, stage_ids: &mut Vec<u8>) -> Result<Value, ApiError> {
    if id == "smartTracking" {
        return Ok(Value::Null);
    }
    if id == "customCurve" {
        return crate::curve::read(io);
    }
    let (command, payload, minimum) = getter(id);
    let data = io.exchange(command, &payload)?;
    if data.len() < minimum {
        return Err(ApiError::new(502, "Invalid setting response length"));
    }
    Ok(match id {
        "dpi" => json!({"x":be16(&data,1),"y":be16(&data,3)}),
        "dpiStages" => {
            let count = usize::from(data[2]);
            if !(1..=5).contains(&count)
                || data[1] == 0
                || data[1] > data[2]
                || data.len() < 3 + count * 7
            {
                return Err(ApiError::new(502, "Invalid DPI stages response"));
            }
            *stage_ids = (0..count).map(|i| data[3 + i * 7]).collect();
            json!({"active":data[1],"stages":(0..count).map(|i|json!({"x":be16(&data,4+i*7),"y":be16(&data,6+i*7)})).collect::<Vec<_>>()})
        }
        "polling" | "pollingWired" | "pollingWireless" => {
            let code = if id == "polling" { data[0] } else { data[1] };
            let rates = if id == "polling" {
                [(8, 125), (2, 500), (1, 1000)]
            } else {
                [(64, 125), (16, 500), (8, 1000)]
            };
            json!(
                rates
                    .iter()
                    .find(|(byte, _)| *byte == code)
                    .ok_or_else(|| ApiError::new(502, "Unsupported polling response"))?
                    .1
            )
        }
        "battery" => json!((f64::from(data[1]) / 255. * 100.).floor()),
        "sleep" => json!(be16(&data, 0)),
        "lowPower" => json!((f64::from(data[0]) / 255. * 100.).floor()),
        "rotation" => json!({"enabled":data[1]==1,"angle":data[2] as i8}),
        "dynamicState" => json!(data[1] == 1),
        "dynamicMode" => json!(data[1]),
        "calibrationState" => json!(data[2] == 1),
        "asymmetricTracking" => {
            json!({"liftOff":u16::from(data[2])+1,"landing":u16::from(data[3])+1})
        }
        _ => unreachable!(),
    })
}
fn apply(io: &mut dyn Exchange, change: &Change, stage_ids: &[u8]) -> Result<Value, ApiError> {
    let id = change.id.as_str();
    let value = &change.value;
    let wire = value.to_wire_value();
    let number = |key: &str| wire[key].as_f64().unwrap();
    let scalar = || value.number().unwrap();
    let mut expected = value.clone();
    let mut command = None;
    let bytes16 = |n: f64| (n as u16).to_be_bytes().to_vec();
    match id {
        "dpi" => {
            let mut data = vec![0];
            data.extend(bytes16(number("x")));
            data.extend(bytes16(number("y")));
            data.extend([0, 0]);
            command = Some(([7, 4, 5], data));
        }
        "dpiStages" => {
            let stages = wire["stages"].as_array().unwrap();
            let active = number("active") as usize;
            if active > stages.len() {
                return Err(ApiError::new(502, "Active stage exceeds the stage count"));
            }
            let mut data = vec![0, active as u8, stages.len() as u8];
            for (index, stage) in stages.iter().enumerate() {
                data.push(
                    stage_ids
                        .get(index)
                        .copied()
                        .unwrap_or_else(|| stage_ids[0].wrapping_add(index as u8)),
                );
                data.extend(bytes16(stage["x"].as_f64().unwrap()));
                data.extend(bytes16(stage["y"].as_f64().unwrap()));
                data.extend([0, 0]);
            }
            command = Some(([data.len() as u8, 4, 6], data));
        }
        "polling" | "pollingWired" | "pollingWireless" => {
            let rate = scalar() as u16;
            let base = match rate {
                125 => 8,
                500 => 2,
                1000 => 1,
                _ => unreachable!(),
            };
            command = Some(if id == "polling" {
                ([1, 0, 5], vec![base])
            } else {
                ([2, 0, 64], vec![(id == "pollingWireless") as u8, base * 8])
            });
        }
        "sleep" => command = Some(([2, 7, 3], bytes16(scalar()))),
        "lowPower" => command = Some(([1, 7, 1], vec![(scalar() / 100. * 255.).ceil() as u8])),
        "rotation" => {
            command = Some((
                [3, 11, 20],
                vec![
                    1,
                    wire["enabled"].as_bool().unwrap() as u8,
                    number("angle") as i8 as u8,
                ],
            ))
        }
        "dynamicState" => command = Some(([2, 11, 16], vec![1, wire.as_bool().unwrap() as u8])),
        "dynamicMode" => command = Some(([2, 11, 17], vec![1, scalar() as u8])),
        "customCurve" => expected = crate::curve::write(io, value)?,
        "asymmetricTracking" => {
            if number("landing") >= number("liftOff") {
                return Err(ApiError::new(
                    502,
                    "Landing distance must be below lift-off distance",
                ));
            }
            io.exchange([3, 11, 3], &[0, 4, 1])?;
            io.exchange([4, 11, 11], &[0, 4, 4, 0])?;
            io.exchange(
                [10, 11, 5],
                &[
                    0,
                    4,
                    (number("liftOff") - 1.) as u8,
                    (number("landing") - 1.) as u8,
                ],
            )?;
        }
        "smartTracking" => {
            io.exchange([3, 11, 3], &[0, 4, 1])?;
            let data = [0, 4, 1, (scalar() - 1.) as u8];
            if io.exchange([4, 11, 11], &data)? != data {
                return Err(ApiError::new(
                    502,
                    "Tracking acknowledgement differs from the requested value",
                ));
            }
            return Ok(json!({"verified":true,"verification":"hardware-acknowledgement"}));
        }
        _ => return Err(ApiError::new(502, "Native setting unavailable")),
    }
    if let Some((command, data)) = command {
        io.exchange(command, &data)?;
    }
    let actual = JsValue::from(get(io, id, &mut Vec::new())?);
    if actual != expected {
        return Err(ApiError::new(
            502,
            "Device readback differs from the requested value",
        ));
    }
    Ok(json!({"verified":true,"verification":"hardware-readback"}))
}
