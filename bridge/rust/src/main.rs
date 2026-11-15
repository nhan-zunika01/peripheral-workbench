use hidapi::{HidApi, HidDevice};
use razer_hid_helper::{allowed_command, curve_chunk, feature_report, feature_response, packet};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};
use std::time::Duration;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
enum Request {
    Enumerate,
    Open { path: String },
    Exchange { command: [u8; 3], data: Vec<u8> },
    Close,
}

fn supported(device: &hidapi::DeviceInfo) -> bool {
    device.vendor_id() == 0x1532
        && [0xde, 0xdf].contains(&device.product_id())
        && device.interface_number() == 0
}

fn handle(
    request: Request,
    device: &mut Option<HidDevice>,
    transaction: &mut u8,
    allow_writes: bool,
) -> Result<Value, String> {
    match request {
        Request::Enumerate => {
            let api = HidApi::new().map_err(|error| error.to_string())?;
            Ok(Value::Array(api.device_list().filter(|item| item.vendor_id() == 0x1532).map(|item| json!({
                "path": item.path().to_string_lossy(), "vendorId": item.vendor_id(), "productId": item.product_id(),
                "interface": item.interface_number(), "usagePage": item.usage_page(), "usage": item.usage(),
                "product": item.product_string(), "serialNumber": item.serial_number()
            })).collect()))
        }
        Request::Open { path } => {
            if device.is_some() {
                return Err("A HID interface is already open".into());
            }
            // Enumerate again at open; never fall back to VID/PID or a different physical unit.
            let api = HidApi::new().map_err(|error| error.to_string())?;
            let selected = api
                .device_list()
                .find(|item| supported(item) && item.path().to_bytes() == path.as_bytes())
                .ok_or("Selected device is no longer attached or its interface is unsupported")?;
            *device = Some(
                selected
                    .open_device(&api)
                    .map_err(|error| error.to_string())?,
            );
            *transaction = 0;
            Ok(json!(true))
        }
        Request::Exchange { command, data } => {
            if !allowed_command(command, &data, allow_writes) {
                return Err("Unsupported command or Rust transport is read-only".into());
            }
            let connection = device.as_ref().ok_or("No HID interface is open")?;
            *transaction = *transaction % 31 + 1;
            let sent = packet(command, &data, *transaction)?;
            // hidapi returns Result<()> for sends; Windows validates completion internally.
            connection
                .send_feature_report(&feature_report(&sent))
                .map_err(|error| error.to_string())?;
            std::thread::sleep(Duration::from_millis(20));
            let mut bytes = [0; 91];
            let length = connection
                .get_feature_report(&mut bytes)
                .map_err(|error| error.to_string())?;
            let decoded = feature_response(&bytes[..length], &sent)?;
            if command == [37, 11, 147] {
                if data.len() != 5 {
                    return Err("Invalid custom curve request".into());
                }
                curve_chunk(&decoded, data[3], data[4])?;
            }
            Ok(json!(decoded))
        }
        Request::Close => {
            *device = None;
            Ok(json!(true))
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let allow_writes = args == ["--allow-writes"];
    if !args.is_empty() && !allow_writes {
        return Err("Usage: razer-hid-helper [--allow-writes]".into());
    }
    razer_hid_helper::ensure_production_read_only(allow_writes)?;
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut device = None;
    let mut transaction = 0;
    loop {
        let mut bytes = Vec::new();
        let length = input.by_ref().take(16385).read_until(b'\n', &mut bytes)?;
        if length == 0 {
            break;
        }
        if length > 16384 || bytes.last() != Some(&b'\n') {
            return Err("Request too large or incomplete".into());
        }
        let result = serde_json::from_slice::<Request>(&bytes)
            .map_err(|error| error.to_string())
            .and_then(|request| handle(request, &mut device, &mut transaction, allow_writes));
        let reply = match result {
            Ok(value) => json!({ "result": value }),
            Err(error) => json!({ "error": error }),
        };
        writeln!(output, "{reply}")?;
        output.flush()?;
    }
    Ok(())
}
