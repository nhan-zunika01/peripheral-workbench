pub mod adapter;
pub mod api_error;
pub mod backend;
pub mod cli;
pub mod coordinator;
pub mod curve;
pub mod dispatch;
pub mod http;
pub mod http_server;
pub mod inventory;
pub mod js_value;
pub mod physical_backend;
pub mod process;
pub mod recovery;
pub mod recovery_http;
pub mod recovery_owner;
mod recovery_snapshot;
pub mod schema;
pub mod session_guard;
pub mod socket;
pub mod windows_inventory;
pub mod worker;
pub mod worker_native;
pub mod worker_session;
pub use adapter::{
    inspect, inspect_target, inspect_with_mode, ApiError, Change, Exchange, ExpectedValue,
};
pub use js_value::JsValue;
pub use schema::validate_value;

pub const REPORT_LEN: usize = 90;
pub const FEATURE_LEN: usize = 91;

pub fn ensure_production_read_only(allow_writes: bool) -> Result<(), String> {
    if allow_writes {
        Err("Hardware writes are disabled: no verified model/firmware/setting evidence; --allow-writes is only a request".into())
    } else {
        Ok(())
    }
}

pub fn checksum(packet: &[u8; REPORT_LEN]) -> u8 {
    packet[2..88].iter().fold(0, |sum, byte| sum ^ byte)
}

pub fn packet(command: [u8; 3], data: &[u8], transaction: u8) -> Result<[u8; REPORT_LEN], String> {
    if command[0] > 80 || data.len() > usize::from(command[0]) || !(1..=31).contains(&transaction) {
        return Err("Invalid native command".into());
    }
    let mut result = [0; REPORT_LEN];
    result[1] = transaction;
    result[5..8].copy_from_slice(&command);
    result[8..8 + data.len()].copy_from_slice(data);
    result[88] = checksum(&result);
    Ok(result)
}

pub fn response(bytes: &[u8], sent: &[u8; REPORT_LEN]) -> Result<Vec<u8>, String> {
    let result: &[u8; REPORT_LEN] = bytes
        .try_into()
        .map_err(|_| "Invalid native response length")?;
    if result[5] > 80 {
        return Err("Invalid native response length".into());
    }
    if result[88] != checksum(result) {
        return Err("Native response checksum failed".into());
    }
    if result[1] != sent[1] || result[6..8] != sent[6..8] {
        return Err(
            "Native response did not match the request; Synapse may be using the device".into(),
        );
    }
    if result[0] != 2 {
        return Err(format!(
            "Device rejected the command (status {})",
            result[0]
        ));
    }
    Ok(result[8..8 + usize::from(result[5])].to_vec())
}

pub fn feature_report(sent: &[u8; REPORT_LEN]) -> [u8; FEATURE_LEN] {
    let mut report = [0; FEATURE_LEN];
    report[1..].copy_from_slice(sent);
    report
}

pub fn feature_response(bytes: &[u8], sent: &[u8; REPORT_LEN]) -> Result<Vec<u8>, String> {
    if bytes.len() != FEATURE_LEN || bytes[0] != 0 {
        return Err("Invalid HID feature report".into());
    }
    response(&bytes[1..], sent)
}

pub fn curve_chunk(data: &[u8], offset: u8, count: u8) -> Result<Vec<f32>, String> {
    if count == 0
        || count > 8
        || usize::from(offset) + usize::from(count) > 250
        || data.len() < 5 + usize::from(count) * 4
        || data[..5] != [1, 3, 250, offset, count]
    {
        return Err("Invalid custom curve response".into());
    }
    data[5..5 + usize::from(count) * 4]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| {
            let point = f32::from_le_bytes(*bytes);
            if point.is_finite() {
                Ok(point)
            } else {
                Err("Invalid custom curve point".into())
            }
        })
        .collect()
}

// Only commands used by the existing Viper adapter may cross the internal helper boundary.
pub fn allowed_command(command: [u8; 3], data: &[u8], allow_writes: bool) -> bool {
    let known = matches!(
        command,
        [2, 0, 129]
            | [7, 4, 133]
            | [80, 4, 134]
            | [1, 0, 133]
            | [2, 0, 192]
            | [2, 7, 128]
            | [2, 7, 131]
            | [1, 7, 129]
            | [3, 11, 148]
            | [2, 11, 144]
            | [2, 11, 145]
            | [37, 11, 147]
            | [3, 11, 131]
            | [10, 11, 133]
            | [7, 4, 5]
            | [1, 0, 5]
            | [2, 0, 64]
            | [2, 7, 3]
            | [1, 7, 1]
            | [3, 11, 20]
            | [2, 11, 16]
            | [2, 11, 17]
            | [37, 11, 19]
            | [3, 11, 3]
            | [4, 11, 11]
            | [10, 11, 5]
    ) || (command[1..] == [4, 6]
        && (10..=38).contains(&command[0])
        && (command[0] - 3).is_multiple_of(7));
    if !known || (command[2] < 128 && !allow_writes) || data.len() > usize::from(command[0]) {
        return false;
    }
    let dpi = |bytes: &[u8]| (100..=35000).contains(&u16::from_be_bytes([bytes[0], bytes[1]]));
    match command {
        [2, 0, 129] | [1, 0, 133] | [2, 7, 131] | [1, 7, 129] => data.is_empty(),
        [7, 4, 133] | [80, 4, 134] | [2, 7, 128] => data == [0],
        [2, 0, 192] => matches!(data, [0] | [1]),
        [3, 11, 148] | [2, 11, 144] | [2, 11, 145] => data == [1],
        [3, 11, 131] | [10, 11, 133] => data == [0, 4],
        [7, 4, 5] => {
            data.len() == 7
                && data[0] == 0
                && data[5..] == [0, 0]
                && dpi(&data[1..3])
                && dpi(&data[3..5])
        }
        [_, 4, 6] => {
            data.len() == usize::from(command[0])
                && data[0] == 0
                && (1..=5).contains(&data[2])
                && data.len() == 3 + usize::from(data[2]) * 7
                && (1..=data[2]).contains(&data[1])
                && data[3..]
                    .as_chunks::<7>()
                    .0
                    .iter()
                    .all(|stage| dpi(&stage[1..3]) && dpi(&stage[3..5]) && stage[5..] == [0, 0])
        }
        [1, 0, 5] => matches!(data, [1] | [2] | [8]),
        [2, 0, 64] => data.len() == 2 && data[0] <= 1 && [8, 16, 64].contains(&data[1]),
        [2, 7, 3] => {
            data.len() == 2 && {
                let seconds = u16::from_be_bytes([data[0], data[1]]);
                (60..=900).contains(&seconds) && seconds.is_multiple_of(60)
            }
        }
        [1, 7, 1] => {
            data.len() == 1
                && (1u32..=20).any(|step| (step * 5 * 255).div_ceil(100) == u32::from(data[0]))
        }
        [3, 11, 20] => {
            data.len() == 3 && data[0] == 1 && data[1] <= 1 && (-44..=44).contains(&(data[2] as i8))
        }
        [2, 11, 16] => data.len() == 2 && data[0] == 1 && data[1] <= 1,
        [2, 11, 17] => data.len() == 2 && data[0] == 1 && data[1] <= 3,
        [3, 11, 3] => data == [0, 4, 1],
        [4, 11, 11] => {
            data == [0, 4, 4, 0] || (data.len() == 4 && data[..3] == [0, 4, 1] && data[3] <= 2)
        }
        [10, 11, 5] => {
            data.len() == 4
                && data[..2] == [0, 4]
                && (1..=25).contains(&data[2])
                && data[3] < data[2]
        }
        [37, 11, id @ (19 | 147)] => {
            if data.len() < 5
                || data[..3] != [1, 3, 250]
                || !data[3].is_multiple_of(8)
                || data[3] > 248
                || data[4] != (250 - data[3]).min(8)
            {
                return false;
            }
            if id == 147 {
                data.len() == 5
            } else {
                data.len() == 5 + usize::from(data[4]) * 4
                    && data[5..].as_chunks::<4>().0.iter().all(|bytes| {
                        let point = f32::from_le_bytes(*bytes);
                        point.is_finite() && point >= 0.1
                    })
            }
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn report_id_and_lengths_are_exact() {
        let sent = packet([2, 0, 129], &[], 31).unwrap();
        let mut feature = feature_report(&sent);
        feature[1] = 2;
        assert_eq!(feature_response(&feature, &sent).unwrap(), [0, 0]);
        assert!(feature_response(&feature[..90], &sent).is_err());
        feature[0] = 1;
        assert!(feature_response(&feature, &sent).is_err());
    }
    #[test]
    fn bounds_and_allowlist() {
        for transaction in [0, 32, 255] {
            assert!(packet([1, 0, 133], &[], transaction).is_err());
        }
        assert!(packet([81, 0, 1], &[], 1).is_err());
        assert!(packet([1, 0, 1], &[1, 2], 1).is_err());
        assert!(allowed_command([2, 0, 129], &[], false));
        assert!(!allowed_command([1, 7, 1], &[10], false));
        assert!(allowed_command([1, 7, 1], &[13], true));
        assert!(!allowed_command([1, 255, 255], &[], true));
        assert!(!allowed_command([2, 7, 3], &[0, 1], true));
        assert!(allowed_command([2, 7, 3], &[0, 60], true));
        assert!(!allowed_command([37, 11, 19], &[], true));
        assert!(!allowed_command([37, 11, 147], &[1, 3, 250, 1, 8], false));
        let mut chunk = vec![1, 3, 250, 248, 2];
        chunk.extend(0.1_f32.to_le_bytes());
        chunk.extend(1.0_f32.to_le_bytes());
        assert!(allowed_command([37, 11, 19], &chunk, true));
        chunk[5..9].copy_from_slice(&f32::INFINITY.to_le_bytes());
        assert!(!allowed_command([37, 11, 19], &chunk, true));
    }
    #[test]
    fn float32_curve_rejects_nonfinite_and_misordered_chunks() {
        let mut data = vec![1, 3, 250, 0, 1];
        data.extend(0.1_f32.to_le_bytes());
        assert_eq!(curve_chunk(&data, 0, 1).unwrap(), [0.1_f32]);
        assert!(curve_chunk(&data, 1, 1).is_err());
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            data[5..].copy_from_slice(&value.to_le_bytes());
            assert!(curve_chunk(&data, 0, 1).is_err());
        }
    }
}
