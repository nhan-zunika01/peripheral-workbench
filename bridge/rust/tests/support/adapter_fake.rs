use razer_hid_helper::{adapter::Exchange, ApiError};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

pub struct FakeExchange {
    pub log: Arc<Mutex<Vec<Value>>>,
    pub config: Value,
    pub getters: BTreeMap<String, (&'static str, Vec<u8>)>,
    pub curve: Vec<f32>,
}
impl FakeExchange {
    // Some test targets use only the configurable constructor.
    #[allow(dead_code)]
    pub fn plain() -> Self {
        Self::new(json!({}), Arc::new(Mutex::new(Vec::new())))
    }
    pub fn new(config: Value, log: Arc<Mutex<Vec<Value>>>) -> Self {
        let rows: Vec<(&str, &str, Vec<u8>)> = vec![
            ("2,0,129", "firmware", vec![1, 2]),
            ("7,4,133", "dpi", vec![0, 3, 32, 3, 32]),
            (
                "80,4,134",
                "dpiStages",
                vec![0, 1, 1, 1, 3, 32, 3, 32, 0, 0],
            ),
            ("1,0,133", "polling", vec![1]),
            ("2,7,128", "battery", vec![0, 128]),
            ("2,7,131", "sleep", vec![1, 44]),
            ("1,7,129", "lowPower", vec![51]),
            ("3,11,148", "rotation", vec![1, 0, 0]),
            ("2,11,144", "dynamicState", vec![1, 0]),
            ("2,11,145", "dynamicMode", vec![1, 0]),
            ("3,11,131", "calibrationState", vec![0, 4, 1]),
            ("10,11,133", "asymmetricTracking", vec![0, 4, 2, 1]),
            ("2,0,192:0", "pollingWired", vec![0, 8]),
            ("2,0,192:1", "pollingWireless", vec![1, 8]),
        ];
        Self {
            config,
            log,
            curve: vec![1.; 250],
            getters: rows
                .into_iter()
                .map(|(k, id, v)| (k.into(), (id, v)))
                .collect(),
        }
    }
    fn unavailable(&self, id: &str) -> bool {
        let check = |v: &Value| {
            v.as_str()
                .map(|s| s == id || s == "smartTracking" && id == "calibrationState")
                .unwrap_or(false)
        };
        match self.config.get("unavailable") {
            Some(Value::Array(v)) => v.iter().any(check),
            Some(v) => check(v),
            None => false,
        }
    }
}
impl Exchange for FakeExchange {
    fn exchange(&mut self, command: [u8; 3], data: &[u8]) -> Result<Vec<u8>, ApiError> {
        self.log
            .lock()
            .unwrap()
            .push(json!({"action":"exchange","command":command,"data":data}));
        let key = command
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(",");
        if matches!(command, [37, 11, 147] | [37, 11, 19]) {
            if self.unavailable("customCurve") {
                return Err(ApiError::new(502, "Unavailable getter"));
            }
            let (offset, count) = (data[3] as usize, data[4] as usize);
            if command[2] == 19 {
                if self.config["failCurveAt"].as_u64() == Some(offset as u64) {
                    return Err(ApiError::new(502, "Simulated uncertain chunk"));
                }
                for i in 0..count {
                    self.curve[offset + i] =
                        f32::from_le_bytes(data[5 + i * 4..9 + i * 4].try_into().unwrap());
                }
            }
            let mut result = data[..5].to_vec();
            for point in &self.curve[offset..offset + count] {
                result.extend(point.to_le_bytes());
            }
            return Ok(result);
        }
        let lookup = if command == [2, 0, 192] {
            format!("{key}:{}", data[0])
        } else {
            key.clone()
        };
        if let Some((id, value)) = self.getters.get(&lookup) {
            if self.unavailable(id) {
                return Err(ApiError::new(502, "Unavailable getter"));
            }
            return Ok(if self.config["shortGetter"] == *id {
                vec![]
            } else {
                value.clone()
            });
        }
        if self.config["dropWrites"] != true {
            let target = match command {
                [7, 4, 5] => Some("7,4,133"),
                [1, 0, 5] => Some("1,0,133"),
                [2, 7, 3] => Some("2,7,131"),
                [1, 7, 1] => Some("1,7,129"),
                [3, 11, 20] => Some("3,11,148"),
                [2, 11, 16] => Some("2,11,144"),
                [2, 11, 17] => Some("2,11,145"),
                [10, 11, 5] => Some("10,11,133"),
                [_, 4, 6] => Some("80,4,134"),
                _ => None,
            };
            if let Some(target) = target {
                self.getters.get_mut(target).unwrap().1 = data.to_vec();
            } else if command == [2, 0, 64] {
                self.getters
                    .get_mut(&format!("2,0,192:{}", data[0]))
                    .unwrap()
                    .1 = data.to_vec();
            } else if !matches!(command, [3, 11, 3] | [4, 11, 11]) {
                panic!("Unexpected fake command {key}")
            }
        }
        Ok(
            if self.config["badAcknowledgement"] == true && command == [4, 11, 11] {
                vec![]
            } else {
                data.to_vec()
            },
        )
    }
}
impl Drop for FakeExchange {
    fn drop(&mut self) {
        self.log.lock().unwrap().push(json!({"action":"close"}));
    }
}
