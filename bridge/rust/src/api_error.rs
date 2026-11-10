use crate::JsValue;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub status: u16,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_value: Option<Value>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub internal: bool,
}
impl<'de> Deserialize<'de> for ApiError {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let invalid = || serde::de::Error::custom("Invalid API error");
        let JsValue::Object(mut fields) = JsValue::deserialize(d)? else {
            return Err(invalid());
        };
        let status = fields
            .remove("status")
            .and_then(|v| v.number())
            .ok_or_else(invalid)?;
        if !(0.0..=65535.0).contains(&status) || status.fract() != 0. {
            return Err(invalid());
        }
        let Some(JsValue::String(error)) = fields.remove("error") else {
            return Err(invalid());
        };
        let code = match fields.remove("code") {
            None | Some(JsValue::Null) => None,
            Some(JsValue::String(s)) => Some(s),
            _ => return Err(invalid()),
        };
        let actual_value = fields
            .remove("actualValue")
            .map(serde_json::to_value)
            .transpose()
            .map_err(serde::de::Error::custom)?;
        let internal = match fields.remove("internal") {
            None => false,
            Some(JsValue::Bool(value)) => value,
            _ => return Err(invalid()),
        };
        Ok(Self {
            status: status as u16,
            error,
            code,
            actual_value,
            internal,
        })
    }
}
impl ApiError {
    pub fn new(status: u16, error: impl Into<String>) -> Self {
        Self {
            status,
            error: error.into(),
            code: None,
            actual_value: None,
            internal: false,
        }
    }
    pub fn internal(error: impl Into<String>) -> Self {
        Self {
            internal: true,
            ..Self::new(502, error)
        }
    }
    pub fn public_message(&self) -> &str {
        if self.internal {
            "Native transport failed; reconnect and inspect the companion console."
        } else {
            &self.error
        }
    }
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(&self.error)
    }
}
impl std::error::Error for ApiError {}
