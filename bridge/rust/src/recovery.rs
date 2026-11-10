use crate::{
    process::{Observation, ProcessTable},
    session_guard::{self, GuardRecord, RecoveryLock, SessionGuard, WriteRisk},
    socket::ExclusiveSocket,
};
use serde_json::{json, Value};
use std::{
    io,
    path::{Path, PathBuf},
    sync::Arc,
};
pub fn audit_generation(
    path: &Path,
    table: &mut dyn ProcessTable,
) -> io::Result<(GuardRecord, Vec<Value>)> {
    let first = session_guard::load(path)?;
    let mut evidence = vec![];
    let mut audit = |process: &crate::process::ProcessIdentity| -> io::Result<()> {
        let observation = table.observe(process)?;
        if observation == Observation::Active {
            table.wait(process)?;
        }
        evidence.push(json!({"process":process,"observation":observation,"waited":observation==Observation::Active}));
        Ok(())
    };
    audit(&first.parent)?;
    let record = session_guard::load(path)?;
    if record.parent != first.parent || record.nonce != first.nonce {
        return Err(io::Error::other(
            "Recovery generation changed during parent audit",
        ));
    }
    if record.phase == "spawning" {
        return Err(io::Error::other("A spawning worker has unknown identity; process exit cannot be proven. Guard retained, including for acknowledgement."));
    }
    for child in &record.children {
        audit(child)?;
    }
    Ok((record, evidence))
}
#[derive(Debug, PartialEq, Eq)]
pub enum ReadPlan {
    NoWrite,
    Target(String),
    UnknownAcknowledgement,
}
pub fn read_plan(
    record: &GuardRecord,
    selected: Option<&str>,
    acknowledge: bool,
) -> io::Result<ReadPlan> {
    record.validate()?;
    if selected.is_some_and(|id| !session_guard::valid_id(id)) {
        return Err(io::Error::other("Invalid device identity"));
    }
    if record.write_risk == WriteRisk::NoWriteStarted {
        return Ok(ReadPlan::NoWrite);
    }
    if let Some(target) = &record.affected_device_id {
        if selected.is_some_and(|id| id != target) {
            return Err(io::Error::other(
                "Recovery is pinned to the affected device",
            ));
        }
        return Ok(ReadPlan::Target(target.clone()));
    }
    if acknowledge {
        Ok(ReadPlan::UnknownAcknowledgement)
    } else {
        Err(io::Error::other("Affected device is unknown; guard retained. Explicit unresolved acknowledgement is required."))
    }
}
pub struct RecoveryResources {
    pub guard: SessionGuard,
    pub socket: Arc<ExclusiveSocket>,
    pub lock: RecoveryLock,
}
pub fn normal_session(
    path: PathBuf,
    port: u16,
) -> io::Result<(SessionGuard, Arc<ExclusiveSocket>)> {
    normal_session_with_mode(path, port, false)
}
pub fn normal_session_with_mode(
    path: PathBuf,
    port: u16,
    allow_writes: bool,
) -> io::Result<(SessionGuard, Arc<ExclusiveSocket>)> {
    let guard = SessionGuard::create_with_mode(path, allow_writes)?;
    match ExclusiveSocket::reserve(port) {
        Ok(socket) => Ok((guard, Arc::new(socket))),
        Err(error) => {
            guard.finish()?;
            Err(error)
        }
    }
}
pub fn begin(
    path: PathBuf,
    port: u16,
    table: &mut dyn ProcessTable,
) -> io::Result<RecoveryResources> {
    let lock = RecoveryLock::acquire(&path)?;
    session_guard::load(&path)?;
    let (owner, mut evidence) = crate::recovery_owner::RecoveryOwner::claim(&path, table)?;
    let (record, guard_evidence) = audit_generation(&path, table)?;
    evidence.extend(guard_evidence);
    let socket = Arc::new(ExclusiveSocket::reserve(port)?);
    let guard = SessionGuard::adopt(path, record, evidence)?;
    owner.adopted(&guard)?;
    Ok(RecoveryResources {
        guard,
        socket,
        lock,
    })
}
pub fn outcome(
    record: &GuardRecord,
    plan: &ReadPlan,
    ack: bool,
    state: Option<&Value>,
) -> io::Result<Value> {
    match plan {
        ReadPlan::NoWrite => {
            Ok(json!({"previousOutcome":"no-write-started","observedDeviceId":null}))
        }
        ReadPlan::UnknownAcknowledgement if ack => Ok(
            json!({"previousOutcome":"unresolved","affectedDeviceId":null,"observedDeviceId":null,"acknowledgement":"explicit-cli","cause":"Affected device identity is unknown"}),
        ),
        ReadPlan::Target(target) => {
            let state = state.ok_or_else(|| {
                io::Error::other("Recovery read did not establish availability; guard retained")
            })?;
            if !state["connected"].is_boolean() {
                return Err(io::Error::other(
                    "Recovery read availability is indeterminate; guard retained",
                ));
            }
            if state["selectedDeviceId"] != *target {
                return Err(io::Error::other(
                    "Recovery read returned another device identity; guard retained",
                ));
            }
            let connected = state["connected"] == true;
            if ack && connected {
                return Err(io::Error::other(
                    "Affected device is connected; inspect it using normal read-only recovery",
                ));
            }
            if connected {
                Ok(
                    json!({"previousOutcome":"unknown","affectedDeviceId":target,"observedDeviceId":target}),
                )
            } else if ack {
                Ok(
                    json!({"previousOutcome":"unresolved","affectedDeviceId":record.affected_device_id,"observedDeviceId":null,"acknowledgement":"explicit-cli","cause":"Affected device is unavailable"}),
                )
            } else {
                Err(io::Error::other(
                    "Affected device is unavailable; guard retained",
                ))
            }
        }
        _ => Err(io::Error::other(
            "Explicit unresolved acknowledgement is required",
        )),
    }
}
