use crate::ApiError;
use serde::{
    de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize, Serializer,
};
use serde_json::Value;
use std::{collections::BTreeMap, fmt};

#[derive(Clone, Debug)]
pub enum JsValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsValue>),
    Object(BTreeMap<String, JsValue>),
}

impl PartialEq for JsValue {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Null, Self::Null) => true,
            (Self::Bool(a), Self::Bool(b)) => a == b,
            (Self::Number(a), Self::Number(b)) => {
                a == b && (*a != 0. || a.is_sign_negative() == b.is_sign_negative())
            }
            (Self::String(a), Self::String(b)) => a == b,
            (Self::Array(a), Self::Array(b)) => a == b,
            (Self::Object(a), Self::Object(b)) => a == b,
            _ => false,
        }
    }
}
impl JsValue {
    pub fn parse(bytes: &[u8]) -> Result<Self, ApiError> {
        serde_json::from_slice(bytes).map_err(|_| ApiError::new(400, "Invalid JSON"))
    }
    pub fn to_wire_value(&self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(v) => Value::Bool(*v),
            Self::String(v) => Value::String(v.clone()),
            Self::Number(v) => {
                if *v == 0. {
                    Value::from(0)
                } else {
                    Value::from(*v)
                }
            }
            Self::Array(v) => Value::Array(v.iter().map(Self::to_wire_value).collect()),
            Self::Object(v) => Value::Object(
                v.iter()
                    .map(|(k, v)| (k.clone(), v.to_wire_value()))
                    .collect(),
            ),
        }
    }
    pub fn number(&self) -> Option<f64> {
        if let Self::Number(v) = self {
            Some(*v)
        } else {
            None
        }
    }
}
impl From<Value> for JsValue {
    fn from(value: Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(v) => Self::Bool(v),
            Value::Number(v) => Self::Number(v.as_f64().unwrap()),
            Value::String(v) => Self::String(v),
            Value::Array(v) => Self::Array(v.into_iter().map(Self::from).collect()),
            Value::Object(v) => {
                Self::Object(v.into_iter().map(|(k, v)| (k, Self::from(v))).collect())
            }
        }
    }
}
impl Serialize for JsValue {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => s.serialize_unit(),
            Self::Bool(v) => s.serialize_bool(*v),
            Self::Number(v) => {
                if v.is_finite() {
                    s.serialize_f64(*v)
                } else {
                    Err(serde::ser::Error::custom("Nonfinite number"))
                }
            }
            Self::String(v) => s.serialize_str(v),
            Self::Array(v) => v.serialize(s),
            Self::Object(v) => v.serialize(s),
        }
    }
}
struct Seed(usize);
impl<'de> DeserializeSeed<'de> for Seed {
    type Value = JsValue;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<JsValue, D::Error> {
        if self.0 > 64 {
            return Err(de::Error::custom("JSON structural depth exceeds 64"));
        }
        d.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Seed {
    type Value = JsValue;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a finite JSON value")
    }
    fn visit_unit<E: de::Error>(self) -> Result<JsValue, E> {
        Ok(JsValue::Null)
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<JsValue, E> {
        Ok(JsValue::Bool(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<JsValue, E> {
        self.visit_f64(v as f64)
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<JsValue, E> {
        self.visit_f64(v as f64)
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<JsValue, E> {
        if !v.is_finite() {
            return Err(E::custom("Nonfinite number"));
        }
        Ok(JsValue::Number(v))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<JsValue, E> {
        Ok(JsValue::String(v.into()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<JsValue, E> {
        Ok(JsValue::String(v))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<JsValue, A::Error> {
        if self.0 >= 64 {
            return Err(de::Error::custom("JSON structural depth exceeds 64"));
        }
        let mut values = Vec::new();
        while let Some(v) = a.next_element_seed(Seed(self.0 + 1))? {
            values.push(v)
        }
        Ok(JsValue::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<JsValue, A::Error> {
        if self.0 >= 64 {
            return Err(de::Error::custom("JSON structural depth exceeds 64"));
        }
        let mut values = BTreeMap::new();
        while let Some(key) = a.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom("Duplicate JSON key"));
            }
            values.insert(key, a.next_value_seed(Seed(self.0 + 1))?);
        }
        Ok(JsValue::Object(values))
    }
}
impl<'de> Deserialize<'de> for JsValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Seed(0).deserialize(d)
    }
}
