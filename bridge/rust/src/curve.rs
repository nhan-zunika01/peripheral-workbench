use crate::{ApiError, Exchange, JsValue};

pub(crate) fn read(io: &mut dyn Exchange) -> Result<serde_json::Value, ApiError> {
    let mut values = Vec::with_capacity(250);
    for offset in (0..250).step_by(8) {
        let count = (250 - offset).min(8);
        let data = io.exchange([37, 11, 147], &[1, 3, 250, offset as u8, count as u8])?;
        values.extend(
            crate::curve_chunk(&data, offset as u8, count as u8)
                .map_err(|e| ApiError::new(502, e))?
                .into_iter()
                .map(|v| serde_json::Value::from(v as f64)),
        );
    }
    Ok(values.into())
}
pub(crate) fn write(io: &mut dyn Exchange, value: &JsValue) -> Result<JsValue, ApiError> {
    let JsValue::Array(points) = value else {
        return Err(ApiError::new(400, "Invalid custom curve point"));
    };
    let normalized: Vec<f32> = points.iter().map(|v| v.number().unwrap() as f32).collect();
    if normalized.iter().any(|v| !v.is_finite() || *v < 0.1) {
        return Err(ApiError::new(502, "Invalid custom curve point"));
    }
    io.exchange([2, 11, 16], &[1, 1])?;
    io.exchange([2, 11, 17], &[1, 3])?;
    for offset in (0..250).step_by(8) {
        let count = (250 - offset).min(8);
        let mut data = vec![1, 3, 250, offset as u8, count as u8];
        for value in &normalized[offset..offset + count] {
            data.extend(value.to_le_bytes())
        }
        io.exchange([37, 11, 19], &data)?;
    }
    Ok(JsValue::Array(
        normalized
            .into_iter()
            .map(|n| JsValue::Number(n as f64))
            .collect(),
    ))
}
