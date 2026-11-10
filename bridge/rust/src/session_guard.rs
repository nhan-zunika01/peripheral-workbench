use crate::process::{self, ProcessIdentity};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

pub fn valid_id(id: &str) -> bool {
    id.len() == 24
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn sentinel_path() -> io::Result<PathBuf> {
    let root = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| io::Error::other("LOCALAPPDATA is required"))?;
    Ok(PathBuf::from(root).join("RazerDeviceControl/companion-session.json"))
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum WriteRisk {
    NoWriteStarted,
    #[default]
    MayHaveWritten,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case", deny_unknown_fields)]
pub enum PreviousOutcome {
    Unknown {
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    Confirmed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuardRecord {
    pub parent: ProcessIdentity,
    pub children: Vec<ProcessIdentity>,
    pub nonce: String,
    pub phase: String,
    #[serde(default)]
    pub parent_allow_writes: bool,
    #[serde(default)]
    pub write_risk: WriteRisk,
    #[serde(default)]
    pub affected_device_id: Option<String>,
    #[serde(default)]
    pub audit: Vec<Value>,
    #[serde(default)]
    pub previous_outcome: Option<PreviousOutcome>,
}
impl GuardRecord {
    pub fn validate(&self) -> io::Result<()> {
        self.parent.validate()?;
        for child in &self.children {
            child.validate()?;
        }
        if self.nonce.len() != 64
            || !self
                .nonce
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !["starting", "spawning", "worker-pending", "idle", "recovery"]
                .contains(&self.phase.as_str())
            || self.children.len() > 1
            || self
                .children
                .iter()
                .any(|child| child.pid == self.parent.pid)
            || ((self.phase == "worker-pending") != (self.children.len() == 1))
            || self
                .affected_device_id
                .as_ref()
                .is_some_and(|id| !valid_id(id))
            || (self.write_risk == WriteRisk::NoWriteStarted && self.affected_device_id.is_some())
            || (self.write_risk == WriteRisk::NoWriteStarted && self.previous_outcome.is_some())
            || match &self.previous_outcome {
                Some(PreviousOutcome::Unknown { device_id }) => {
                    !valid_id(device_id) || self.affected_device_id.as_ref() != Some(device_id)
                }
                Some(PreviousOutcome::Confirmed) => self.affected_device_id.is_none(),
                None => false,
            }
        {
            return Err(io::Error::other("Invalid companion guard metadata"));
        }
        Ok(())
    }
}
pub fn load(path: &Path) -> io::Result<GuardRecord> {
    let mut bytes = vec![];
    File::open(path)?.take(65537).read_to_end(&mut bytes)?;
    if bytes.len() > 65536 {
        return Err(io::Error::other("Companion guard is too large"));
    }
    crate::JsValue::parse(&bytes).map_err(io::Error::other)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    let old = value.get("writeRisk").is_none();
    let mut record: GuardRecord = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    if old {
        record.write_risk = WriteRisk::MayHaveWritten;
        record.affected_device_id = None;
        record.previous_outcome = None;
    }
    record.validate()?;
    Ok(record)
}
fn write_file(path: &Path, record: &GuardRecord) -> io::Result<()> {
    record.validate()?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(&serde_json::to_vec(record).map_err(io::Error::other)?)?;
    file.sync_all()
}
pub(crate) fn durable_replace(path: &Path, record: &GuardRecord) -> io::Result<()> {
    let temp = path.with_extension(format!("{}.tmp", process::nonce()?));
    write_file(&temp, record)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let wide = |p: &Path| {
            p.as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>()
        };
        if unsafe {
            MoveFileExW(
                wide(&temp).as_ptr(),
                wide(path).as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(not(windows))]
    {
        fs::rename(&temp, path)?;
    }
    Ok(())
}
pub struct SessionGuard {
    path: PathBuf,
    record: GuardRecord,
}
impl SessionGuard {
    pub fn create_at(path: PathBuf) -> io::Result<Self> {
        Self::create_with_mode(path, false)
    }
    pub fn create_with_mode(path: PathBuf, parent_allow_writes: bool) -> io::Result<Self> {
        crate::recovery_owner::refuse_existing(&path)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let record = GuardRecord {
            parent: process::current()?,
            children: vec![],
            nonce: process::nonce()?,
            phase: "starting".into(),
            parent_allow_writes,
            write_risk: WriteRisk::NoWriteStarted,
            affected_device_id: None,
            audit: vec![],
            previous_outcome: None,
        };
        write_file(&path, &record)?;
        Ok(Self { path, record })
    }
    pub fn adopt(path: PathBuf, mut record: GuardRecord, audit: Vec<Value>) -> io::Result<Self> {
        record.parent = process::current()?;
        record.children.clear();
        record.nonce = process::nonce()?;
        record.phase = "recovery".into();
        record.parent_allow_writes = false;
        record.audit.extend(audit);
        durable_replace(&path, &record)?;
        Ok(Self { path, record })
    }
    pub fn record(&self) -> &GuardRecord {
        &self.record
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn spawning(&mut self) -> io::Result<()> {
        if !self.record.children.is_empty() {
            return Err(io::Error::other("A worker is still registered"));
        }
        let mut next = self.record.clone();
        next.phase = "spawning".into();
        self.update(next)
    }
    pub fn spawn_failed_or_reaped(&mut self) -> io::Result<()> {
        if !self.record.children.is_empty() {
            return Err(io::Error::other("A worker is still registered"));
        }
        let mut next = self.record.clone();
        next.phase = "idle".into();
        self.update(next)
    }
    fn update(&mut self, next: GuardRecord) -> io::Result<()> {
        durable_replace(&self.path, &next)?;
        self.record = next;
        Ok(())
    }
    pub fn register(
        &mut self,
        child: ProcessIdentity,
        write_target: Option<&str>,
    ) -> io::Result<()> {
        if !self.record.children.is_empty() {
            return Err(io::Error::other("A worker is still registered"));
        }
        let mut next = self.record.clone();
        next.children.push(child);
        next.phase = "worker-pending".into();
        if let Some(id) = write_target {
            if !valid_id(id) {
                return Err(io::Error::other("Invalid write target"));
            }
            if self.unresolved() {
                return Err(io::Error::other(
                    "An earlier write requires explicit recovery",
                ));
            }
            next.write_risk = WriteRisk::MayHaveWritten;
            next.affected_device_id = Some(id.into());
            next.previous_outcome = Some(PreviousOutcome::Unknown {
                device_id: id.into(),
            });
        }
        self.update(next)
    }
    pub fn confirmed(&mut self) -> io::Result<()> {
        let mut next = self.record.clone();
        next.previous_outcome = Some(PreviousOutcome::Confirmed);
        self.update(next)
    }
    pub fn unresolved(&self) -> bool {
        matches!(
            self.record.previous_outcome,
            Some(PreviousOutcome::Unknown { .. })
        ) || (self.record.write_risk == WriteRisk::MayHaveWritten
            && self.record.previous_outcome.is_none())
    }
    pub fn retire(&mut self, child: &ProcessIdentity) -> io::Result<()> {
        if self.record.children.as_slice() != [child.clone()] {
            return Err(io::Error::other("Worker registration changed"));
        }
        let mut next = self.record.clone();
        next.children.clear();
        next.phase = "idle".into();
        self.update(next)
    }
    pub fn receipt(&self, outcome: Value) -> io::Result<PathBuf> {
        let path = self
            .path
            .with_file_name(format!("recovery-{}.json", self.record.nonce));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        let value = serde_json::json!({"generation":self.record.nonce,"audit":self.record.audit,"outcome":outcome});
        file.write_all(&serde_json::to_vec(&value).map_err(io::Error::other)?)?;
        file.sync_all()?;
        Ok(path)
    }
    pub fn finish(self) -> io::Result<()> {
        if self.unresolved() {
            return Err(io::Error::other(
                "Unknown write outcome requires explicit recovery",
            ));
        }
        self.clear()
    }
    pub fn finish_recovery(self, outcome: Value) -> io::Result<()> {
        self.receipt(outcome)?;
        self.clear()
    }
    fn clear(self) -> io::Result<()> {
        if !self.record.children.is_empty() || self.record.phase == "spawning" {
            return Err(io::Error::other("Worker has not been proven reaped"));
        }
        if load(&self.path)?.nonce != self.record.nonce {
            return Err(io::Error::other("Companion generation changed"));
        }
        fs::remove_file(self.path)
    }
}
pub struct RecoveryLock {
    _file: File,
}
impl RecoveryLock {
    pub fn acquire(path: &Path) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .share_mode(0)
                .open(path.with_extension("recovery-lock"))?;
            Ok(Self { _file: file })
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            Err(io::Error::other("Windows recovery lock required"))
        }
    }
}
