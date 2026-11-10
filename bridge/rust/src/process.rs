use serde::{Deserialize, Serialize};
use std::{io, process::Child};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub creation_time: u64,
}
impl ProcessIdentity {
    pub fn validate(&self) -> io::Result<()> {
        if self.pid == 0 || self.creation_time == 0 {
            Err(io::Error::other("Invalid process identity"))
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Observation {
    Active,
    Signaled,
    Gone,
    Reused,
}
pub trait ProcessTable {
    fn observe(&mut self, process: &ProcessIdentity) -> io::Result<Observation>;
    fn wait(&mut self, process: &ProcessIdentity) -> io::Result<()>;
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{mem::size_of, os::windows::io::AsRawHandle, ptr};
    use windows_sys::Win32::{
        Foundation::*,
        Security::Cryptography::*,
        System::{JobObjects::*, Threading::*},
    };
    pub struct Handle(pub HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    fn creation(handle: HANDLE) -> io::Result<u64> {
        let (mut created, mut exited, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }
    pub fn current() -> io::Result<ProcessIdentity> {
        Ok(ProcessIdentity {
            pid: std::process::id(),
            creation_time: creation(unsafe { GetCurrentProcess() })?,
        })
    }
    pub fn child_identity(child: &Child) -> io::Result<ProcessIdentity> {
        Ok(ProcessIdentity {
            pid: child.id(),
            creation_time: creation(child.as_raw_handle())?,
        })
    }
    pub fn duplicate_parent(child: &Child) -> io::Result<u64> {
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                std::process::id(),
            )
        };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let source = Handle(raw);
        let mut remote = ptr::null_mut();
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                source.0,
                child.as_raw_handle(),
                &mut remote,
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                0,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(remote as usize as u64)
    }
    pub struct ParentLease {
        handle: Handle,
        identity: ProcessIdentity,
    }
    impl ParentLease {
        pub fn transferred(raw: u64) -> io::Result<Self> {
            if raw == 0 || raw > usize::MAX as u64 {
                return Err(io::Error::other("Invalid private parent handle"));
            }
            let raw = raw as usize as HANDLE;
            let pid = unsafe { GetProcessId(raw) };
            if pid == 0 {
                return Err(io::Error::last_os_error());
            }
            let identity = ProcessIdentity {
                pid,
                creation_time: creation(raw)?,
            };
            identity.validate()?;
            Ok(Self {
                handle: Handle(raw),
                identity,
            })
        }
        pub fn identity(&self) -> &ProcessIdentity {
            &self.identity
        }
        pub fn image(&self) -> io::Result<std::path::PathBuf> {
            let mut size = 512;
            while size <= 32768 {
                let mut path = vec![0u16; size];
                let mut length = size as u32;
                if unsafe {
                    QueryFullProcessImageNameW(self.handle.0, 0, path.as_mut_ptr(), &mut length)
                } != 0
                {
                    let value =
                        String::from_utf16(&path[..length as usize]).map_err(io::Error::other)?;
                    return std::fs::canonicalize(value);
                }
                if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
                    return Err(io::Error::last_os_error());
                }
                size *= 2;
            }
            Err(io::Error::other("Parent executable image is too long"))
        }
        pub fn active(&self) -> io::Result<bool> {
            match unsafe { WaitForSingleObject(self.handle.0, 0) } {
                WAIT_TIMEOUT => Ok(true),
                WAIT_OBJECT_0 => Ok(false),
                _ => Err(io::Error::last_os_error()),
            }
        }
    }
    pub fn nonce() -> io::Result<String> {
        let mut bytes = [0u8; 32];
        if unsafe {
            BCryptGenRandom(
                ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        } < 0
        {
            return Err(io::Error::other("OS random generation failed"));
        }
        Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
    }
    pub struct Job(Handle);
    impl Job {
        pub fn assign(child: &Child) -> io::Result<Self> {
            let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Self(Handle(handle));
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            } == 0
                || unsafe { AssignProcessToJobObject(handle, child.as_raw_handle()) } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0 .0, 1);
            }
        }
    }
    pub struct NativeProcessTable;
    impl NativeProcessTable {
        fn open(process: &ProcessIdentity) -> io::Result<Option<Handle>> {
            process.validate()?;
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    process.pid,
                )
            };
            if handle.is_null() {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32)
                    || error.raw_os_error() == Some(ERROR_NOT_FOUND as i32)
                {
                    return Ok(None);
                }
                return Err(error);
            }
            Ok(Some(Handle(handle)))
        }
    }
    impl ProcessTable for NativeProcessTable {
        fn observe(&mut self, process: &ProcessIdentity) -> io::Result<Observation> {
            let Some(handle) = Self::open(process)? else {
                return Ok(Observation::Gone);
            };
            if creation(handle.0)? != process.creation_time {
                return Ok(Observation::Reused);
            }
            match unsafe { WaitForSingleObject(handle.0, 0) } {
                WAIT_OBJECT_0 => Ok(Observation::Signaled),
                WAIT_TIMEOUT => Ok(Observation::Active),
                _ => Err(io::Error::last_os_error()),
            }
        }
        fn wait(&mut self, process: &ProcessIdentity) -> io::Result<()> {
            let Some(handle) = Self::open(process)? else {
                return Ok(());
            };
            if creation(handle.0)? != process.creation_time {
                return Ok(());
            }
            if unsafe { WaitForSingleObject(handle.0, INFINITE) } == WAIT_OBJECT_0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }
    }
}
#[cfg(windows)]
pub use native::{
    child_identity, current, duplicate_parent, nonce, Job, NativeProcessTable, ParentLease,
};

#[cfg(not(windows))]
pub fn current() -> io::Result<ProcessIdentity> {
    Err(io::Error::other("Windows process identity required"))
}
#[cfg(not(windows))]
pub fn nonce() -> io::Result<String> {
    Err(io::Error::other("Windows CSPRNG required"))
}
