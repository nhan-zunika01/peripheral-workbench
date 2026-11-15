use crate::{
    allowed_command, curve_chunk, feature_report, feature_response,
    inventory::{verified_open, InventorySource},
    packet,
    worker::{write_frame, WorkerRequest, WorkerResponse, INVENTORY_LIMIT, OUTPUT_LIMIT},
    ApiError, Exchange,
};
use serde_json::Value;
use std::io;
pub fn open_selected<T>(
    collect: impl FnOnce() -> Result<crate::inventory::Inventory, String>,
    ticket: &crate::inventory::BindingTicket,
    open: impl FnOnce(&crate::inventory::HidNode) -> Result<Option<T>, String>,
) -> Result<T, ApiError> {
    verified_open(collect, ticket, open)
        .map_err(|error| {
            if error.status == 502 {
                ApiError::internal(error.message)
            } else {
                ApiError::new(error.status, error.message)
            }
        })?
        .ok_or_else(|| ApiError::new(502, "Selected device is no longer attached"))
}
#[cfg(windows)]
struct HidExchange {
    device: hidapi::HidDevice,
    transaction: u8,
    allow_writes: bool,
}
#[cfg(windows)]
impl Exchange for HidExchange {
    fn exchange(&mut self, command: [u8; 3], data: &[u8]) -> Result<Vec<u8>, ApiError> {
        let error = |error: String| ApiError::new(502, error);
        if !allowed_command(command, data, self.allow_writes) {
            return Err(ApiError::new(
                400,
                "Unsupported command or Rust transport is read-only",
            ));
        }
        self.transaction = self.transaction % 31 + 1;
        let sent = packet(command, data, self.transaction).map_err(error)?;
        self.device
            .send_feature_report(&feature_report(&sent))
            .map_err(|e| ApiError::internal(e.to_string()))?;
        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut bytes = [0; 91];
        let length = self
            .device
            .get_feature_report(&mut bytes)
            .map_err(|e| ApiError::internal(e.to_string()))?;
        let response = feature_response(&bytes[..length], &sent).map_err(error)?;
        if command == [37, 11, 147] {
            curve_chunk(&response, data[3], data[4]).map_err(error)?;
        }
        Ok(response)
    }
}
pub fn execute(
    request: WorkerRequest,
    argv_allow_writes: bool,
    context: Option<crate::worker_session::WorkerContext>,
) -> Result<Value, ApiError> {
    let denied = || {
        ApiError::new(
            403,
            "Private worker requires a registered live parent session",
        )
    };
    let context = context.ok_or_else(denied)?;
    #[cfg(windows)]
    {
        let expected = crate::session_guard::sentinel_path().map_err(|_| denied())?;
        crate::worker_session::validate_guard_path(&context, &expected)?;
        let guard = crate::session_guard::load(&expected).map_err(|_| denied())?;
        let parent = crate::process::ParentLease::transferred(context.parent_handle)
            .map_err(|_| denied())?;
        let parent_image = parent.image().map_err(|_| denied())?;
        let image = std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .map_err(|_| denied())?;
        let mode = crate::worker_session::authorize(
            &guard,
            &context,
            &crate::process::current().map_err(|_| denied())?,
            parent.identity(),
            parent.active().map_err(|_| denied())?,
            &request,
            argv_allow_writes,
            &crate::worker_session::WorkerAuthority {
                expected_guard: &expected,
                parent_image: &parent_image,
                companion_image: &image,
            },
        )?;
        dispatch_native(request, mode)
    }
    #[cfg(not(windows))]
    {
        let _ = (context, request, argv_allow_writes);
        Err(denied())
    }
}
fn dispatch_native(request: WorkerRequest, argv_allow_writes: bool) -> Result<Value, ApiError> {
    crate::ensure_production_read_only(argv_allow_writes)
        .map_err(|error| ApiError::new(400, error))?;
    #[cfg(windows)]
    {
        use crate::windows_inventory::WindowsInventory;
        match request {
            WorkerRequest::Inventory => {
                serde_json::to_value(WindowsInventory.collect().map_err(ApiError::internal)?)
                    .map_err(|_| ApiError::internal("Invalid inventory response"))
            }
            WorkerRequest::Inspect {
                target,
                tickets,
                change,
                allow_writes,
            } => {
                let allow_writes = allow_writes && argv_allow_writes;
                if change.is_some() && !allow_writes {
                    return Err(ApiError::new(400, "Setting is not writable"));
                }
                if change
                    .as_ref()
                    .is_some_and(|change| change.device_id != target.id)
                {
                    return Err(ApiError::new(409, "Selected device identity changed"));
                }
                if !target.supported {
                    return Err(ApiError::new(
                        400,
                        "No verified adapter bound to this physical device",
                    ));
                }
                let paths: Vec<String> = target
                    .interfaces
                    .iter()
                    .map(|node| node.path.clone())
                    .collect();
                crate::inspect_target(
                    &target.interfaces,
                    &paths,
                    change.as_ref(),
                    allow_writes,
                    |node| {
                        let ticket = tickets
                            .iter()
                            .find(|ticket| {
                                ticket.device_id == target.id && ticket.endpoint == *node
                            })
                            .ok_or_else(|| {
                                ApiError::new(409, "Selected device identity changed")
                            })?;
                        let device = open_selected(
                            || WindowsInventory.collect(),
                            ticket,
                            |endpoint| {
                                let api = hidapi::HidApi::new().map_err(|e| e.to_string())?;
                                let Some(node) = api.device_list().find(|node| {
                                    node.vendor_id() == 0x1532
                                        && [0xde, 0xdf].contains(&node.product_id())
                                        && node.interface_number() == 0
                                        && node.path().to_bytes() == endpoint.path.as_bytes()
                                }) else {
                                    return Ok(None);
                                };
                                node.open_device(&api).map(Some).map_err(|e| e.to_string())
                            },
                        )?;
                        Ok(Box::new(HidExchange {
                            device,
                            transaction: 0,
                            allow_writes,
                        }))
                    },
                )
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (request, argv_allow_writes);
        Err(ApiError::new(502, "Windows HID required"))
    }
}
pub fn run(allow_writes: bool) -> io::Result<()> {
    let envelope = crate::worker::receive_envelope(&mut io::stdin().lock())?;
    let limit = if matches!(envelope.request, WorkerRequest::Inventory) {
        INVENTORY_LIMIT
    } else {
        OUTPUT_LIMIT
    };
    let response = WorkerResponse {
        result: execute(envelope.request, allow_writes, envelope.session),
    };
    write_frame(
        &mut io::stdout().lock(),
        &serde_json::to_vec(&response).map_err(io::Error::other)?,
        limit,
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_dispatch_rejects_write_mode_before_opening_target() {
        let request = crate::worker::WorkerRequest::Inspect {
            target: crate::inventory::Device {
                id: "a".repeat(24),
                name: "unsupported fixture".into(),
                container_id: None,
                interfaces: vec![],
                endpoints: vec![],
                supported: false,
                reason: None,
            },
            tickets: vec![],
            change: None,
            allow_writes: true,
        };
        let error = super::dispatch_native(request, true).unwrap_err();
        assert_eq!(error.status, 400);
        assert!(error
            .error
            .contains("no verified model/firmware/setting evidence"));
    }
}
