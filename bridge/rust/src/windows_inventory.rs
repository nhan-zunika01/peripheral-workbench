use crate::inventory::{AttachmentGuard, Inventory, ObservationWindow, PnpNode, RemovalSignal};

pub struct InventorySession<L> {
    pub guard: AttachmentGuard,
    listener: L,
}

impl<L> InventorySession<L> {
    pub fn start(
        register: impl FnOnce(RemovalSignal) -> Result<L, String>,
        collect: impl FnOnce() -> Result<Inventory, String>,
    ) -> Result<(Self, Inventory, ObservationWindow), String> {
        let (mut guard, signal) = AttachmentGuard::new();
        let listener = register(signal)?;
        let window = guard.begin_observation();
        let inventory = collect()?;
        Ok((Self { guard, listener }, inventory, window))
    }

    pub fn shutdown(self, drain: impl FnOnce()) {
        drain();
        drop(self.listener);
    }
}

#[derive(Debug)]
pub enum BufferError {
    MoreData(usize),
    Missing,
    Win32(u32),
}

pub fn read_sized(
    mut read: impl FnMut(&mut [u8]) -> Result<(usize, u32), BufferError>,
) -> Result<Option<(Vec<u8>, u32)>, String> {
    let mut bytes = vec![];
    for _ in 0..8 {
        match read(&mut bytes) {
            Ok((length, kind)) if length <= bytes.len() => {
                bytes.truncate(length);
                return Ok(Some((bytes, kind)));
            }
            Ok(_) => return Err("Invalid Windows property size".into()),
            Err(BufferError::Missing) => return Ok(None),
            Err(BufferError::Win32(code)) => {
                return Err(format!("Windows device inventory failed ({code})"))
            }
            Err(BufferError::MoreData(required)) => {
                if required <= bytes.len() || required > 1_048_576 {
                    return Err("Invalid Windows property size".into());
                }
                bytes.resize(required, 0);
            }
        }
    }
    Err("Windows device property changed repeatedly".into())
}

pub fn decode_string(kind: u32, bytes: &[u8], expected_kind: u32) -> Result<String, String> {
    if kind != expected_kind || bytes.len() < 2 || !bytes.len().is_multiple_of(2) {
        return Err("Invalid Windows string property".into());
    }
    let units: Vec<_> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let end = units
        .iter()
        .position(|&unit| unit == 0)
        .ok_or("Unterminated Windows string property")?;
    String::from_utf16(&units[..end]).map_err(|_| "Invalid Windows string property".into())
}

pub fn decode_guid(kind: u32, bytes: &[u8]) -> Result<String, String> {
    if kind != 13 || bytes.len() != 16 {
        return Err("Invalid Windows ContainerId property".into());
    }
    Ok(format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{}",
        u32::from_le_bytes(bytes[..4].try_into().unwrap()),
        u16::from_le_bytes(bytes[4..6].try_into().unwrap()),
        u16::from_le_bytes(bytes[6..8].try_into().unwrap()),
        bytes[8],
        bytes[9],
        bytes[10..]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ))
}

pub fn is_razer(instance: &str, name: &str) -> bool {
    let instance = instance.to_lowercase();
    instance.contains("vid_1532")
        || instance.contains("vid&00021532")
        || name.to_lowercase().contains("razer")
}

pub fn pnp_node(
    instance: &str,
    name: &str,
    class: &str,
    registry: Result<Option<String>, String>,
    fallback: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<Option<PnpNode>, String> {
    if !is_razer(instance, name) {
        return Ok(None);
    }
    let registry_complete = registry.is_ok();
    let lookup = match registry.ok().flatten().filter(|s| !s.is_empty()) {
        Some(value) => Ok(Some(value)),
        None => fallback(),
    };
    let container_complete = registry_complete && lookup.is_ok();
    let container = lookup.ok().flatten().unwrap_or_default();
    Ok(Some(PnpNode {
        instance_id: instance.into(),
        container_id: container,
        container_complete,
        extra: serde_json::from_value(serde_json::json!({"name":name,"class":class})).unwrap(),
    }))
}

#[cfg(windows)]
mod native {
    use super::*;
    use crate::inventory::{collect_results, HidNode, InventorySource};
    use std::{
        ffi::c_void,
        mem::{offset_of, size_of},
        ptr,
    };
    use windows_sys::Win32::{
        Devices::{
            DeviceAndDriverInstallation::*, HumanInterfaceDevice::GUID_DEVINTERFACE_HID,
            Properties::DEVPKEY_Device_ContainerId,
        },
        Foundation::*,
        System::Registry::*,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    fn buffer_error(code: u32, required: u32) -> BufferError {
        match code {
            ERROR_INSUFFICIENT_BUFFER | ERROR_MORE_DATA => BufferError::MoreData(required as usize),
            ERROR_NOT_FOUND | ERROR_FILE_NOT_FOUND => BufferError::Missing,
            _ => BufferError::Win32(code),
        }
    }

    struct DeviceSet(HDEVINFO);
    impl Drop for DeviceSet {
        fn drop(&mut self) {
            unsafe {
                SetupDiDestroyDeviceInfoList(self.0);
            }
        }
    }
    impl DeviceSet {
        fn present() -> Result<Self, String> {
            let handle = unsafe {
                SetupDiGetClassDevsW(
                    ptr::null(),
                    ptr::null(),
                    ptr::null_mut(),
                    DIGCF_PRESENT | DIGCF_ALLCLASSES,
                )
            };
            if handle == -1 {
                Err("Windows device inventory failed".into())
            } else {
                Ok(Self(handle))
            }
        }

        fn string(&self, device: &SP_DEVINFO_DATA, property: u32) -> Result<String, String> {
            let value = read_sized(|buffer| {
                let (mut kind, mut required) = (0, 0);
                let ok = unsafe {
                    SetupDiGetDeviceRegistryPropertyW(
                        self.0,
                        device,
                        property,
                        &mut kind,
                        if buffer.is_empty() {
                            ptr::null_mut()
                        } else {
                            buffer.as_mut_ptr()
                        },
                        buffer.len() as u32,
                        &mut required,
                    )
                };
                if ok != 0 {
                    Ok((required as usize, kind))
                } else {
                    let code = unsafe { GetLastError() };
                    // Only the legacy registry-property API uses INVALID_DATA for a missing string.
                    Err(if code == ERROR_INVALID_DATA {
                        BufferError::Missing
                    } else {
                        buffer_error(code, required)
                    })
                }
            })?;
            value
                .map(|(bytes, kind)| decode_string(kind, &bytes, REG_SZ))
                .transpose()
                .map(Option::unwrap_or_default)
        }

        fn instance(&self, device: &SP_DEVINFO_DATA) -> Result<String, String> {
            let mut units = vec![];
            for _ in 0..8 {
                let mut required = 0;
                let ok = unsafe {
                    SetupDiGetDeviceInstanceIdW(
                        self.0,
                        device,
                        if units.is_empty() {
                            ptr::null_mut()
                        } else {
                            units.as_mut_ptr()
                        },
                        units.len() as u32,
                        &mut required,
                    )
                };
                if ok != 0 {
                    let end = units
                        .iter()
                        .position(|&unit| unit == 0)
                        .ok_or("Invalid Windows instance ID")?;
                    return String::from_utf16(&units[..end])
                        .map_err(|_| "Invalid Windows instance ID".into());
                }
                if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER
                    || required as usize <= units.len()
                    || required > 524_288
                {
                    return Err("Windows instance ID lookup failed".into());
                }
                units.resize(required as usize, 0);
            }
            Err("Windows instance ID changed repeatedly".into())
        }

        fn container(&self, device: &SP_DEVINFO_DATA) -> Result<Option<String>, String> {
            read_sized(|buffer| {
                let (mut kind, mut required) = (0, 0);
                let ok = unsafe {
                    SetupDiGetDevicePropertyW(
                        self.0,
                        device,
                        &DEVPKEY_Device_ContainerId,
                        &mut kind,
                        if buffer.is_empty() {
                            ptr::null_mut()
                        } else {
                            buffer.as_mut_ptr()
                        },
                        buffer.len() as u32,
                        &mut required,
                        0,
                    )
                };
                if ok != 0 {
                    Ok((required as usize, kind))
                } else {
                    Err(buffer_error(unsafe { GetLastError() }, required))
                }
            })?
            .map(|(bytes, kind)| decode_guid(kind, &bytes))
            .transpose()
        }
    }

    fn registry_container(instance: &str) -> Result<Option<String>, String> {
        let path = wide(&format!(r"SYSTEM\CurrentControlSet\Enum\{instance}"));
        let name = wide("ContainerID");
        read_sized(|buffer| {
            let (mut kind, mut required) = (0, buffer.len() as u32);
            let code = unsafe {
                RegGetValueW(
                    HKEY_LOCAL_MACHINE,
                    path.as_ptr(),
                    name.as_ptr(),
                    RRF_RT_REG_SZ,
                    &mut kind,
                    if buffer.is_empty() {
                        ptr::null_mut()
                    } else {
                        buffer.as_mut_ptr().cast()
                    },
                    &mut required,
                )
            };
            if code == ERROR_SUCCESS && required as usize > buffer.len() {
                return Err(BufferError::MoreData(required as usize));
            }
            if code == ERROR_SUCCESS {
                Ok((required as usize, kind))
            } else {
                Err(buffer_error(code, required))
            }
        })?
        .map(|(bytes, kind)| decode_string(kind, &bytes, REG_SZ))
        .transpose()
    }

    pub fn collect_pnp() -> Result<Vec<PnpNode>, String> {
        let set = DeviceSet::present()?;
        let mut nodes = vec![];
        for index in 0.. {
            let mut data = SP_DEVINFO_DATA {
                cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            if unsafe { SetupDiEnumDeviceInfo(set.0, index, &mut data) } == 0 {
                if unsafe { GetLastError() } == ERROR_NO_MORE_ITEMS {
                    return Ok(nodes);
                }
                return Err("Windows device enumeration failed".into());
            }
            let instance = set.instance(&data)?;
            let name = set.string(&data, SPDRP_FRIENDLYNAME)?;
            if !is_razer(&instance, &name) {
                continue;
            }
            let class = set.string(&data, SPDRP_CLASS)?;
            if let Some(node) = pnp_node(
                &instance,
                &name,
                &class,
                registry_container(&instance),
                || set.container(&data),
            )? {
                nodes.push(node);
            }
        }
        unreachable!()
    }

    pub struct WindowsInventory;
    impl InventorySource for WindowsInventory {
        fn collect(&mut self) -> Result<Inventory, String> {
            let hid = hidapi::HidApi::new().map_err(|_| "HID device inventory failed".into()).map(|api| {
                api.device_list().filter(|h| h.vendor_id() == 0x1532).map(|h| HidNode {
                    path: h.path().to_string_lossy().into_owned(), vendor_id: h.vendor_id(), product_id: h.product_id(), interface_number: h.interface_number(),
                    extra: serde_json::from_value(serde_json::json!({"usagePage":h.usage_page(),"usage":h.usage(),"product":h.product_string(),"serialNumber":h.serial_number()})).unwrap()
                }).collect()
            });
            Ok(collect_results(hid, collect_pnp()))
        }
    }

    pub struct HidRemovalListener {
        handle: HCMNOTIFICATION,
        _signal: Box<RemovalSignal>,
    }

    unsafe extern "system" fn notification(
        _: HCMNOTIFICATION,
        context: *const c_void,
        action: CM_NOTIFY_ACTION,
        data: *const CM_NOTIFY_EVENT_DATA,
        length: u32,
    ) -> u32 {
        let start = offset_of!(CM_NOTIFY_EVENT_DATA, u)
            + offset_of!(CM_NOTIFY_EVENT_DATA_0_0, SymbolicLink);
        if action == CM_NOTIFY_ACTION_DEVICEINTERFACEREMOVAL
            && !context.is_null()
            && !data.is_null()
            && length as usize >= start + 2
            && (*data).FilterType == CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE
        {
            let units = std::slice::from_raw_parts(
                (data.cast::<u8>().add(start)).cast::<u16>(),
                (length as usize - start) / 2,
            );
            if let Some(end) = units.iter().position(|&u| u == 0) {
                if let Ok(path) = String::from_utf16(&units[..end]) {
                    (*(context.cast::<RemovalSignal>())).removed(&path);
                }
            }
        }
        ERROR_SUCCESS
    }

    impl HidRemovalListener {
        pub fn register(signal: RemovalSignal) -> Result<Self, String> {
            let signal = Box::new(signal);
            let mut filter = CM_NOTIFY_FILTER {
                cbSize: size_of::<CM_NOTIFY_FILTER>() as u32,
                FilterType: CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE,
                ..Default::default()
            };
            filter.u.DeviceInterface.ClassGuid = GUID_DEVINTERFACE_HID;
            let mut handle = ptr::null_mut();
            let status = unsafe {
                CM_Register_Notification(
                    &filter,
                    (&*signal as *const RemovalSignal).cast(),
                    Some(notification),
                    &mut handle,
                )
            };
            if status != CR_SUCCESS {
                return Err(format!(
                    "HID removal listener registration failed ({status})"
                ));
            }
            Ok(Self {
                handle,
                _signal: signal,
            })
        }
    }
    impl Drop for HidRemovalListener {
        fn drop(&mut self) {
            unsafe {
                CM_Unregister_Notification(self.handle);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn malformed_container_data_is_an_error_instead_of_known_absence() {
            assert!(read_sized(|_| Err(buffer_error(ERROR_INVALID_DATA, 0))).is_err());
            assert!(read_sized(|_| Err(buffer_error(ERROR_NOT_FOUND, 0)))
                .unwrap()
                .is_none());
        }
    }
}

#[cfg(windows)]
pub use native::{collect_pnp, HidRemovalListener, WindowsInventory};
