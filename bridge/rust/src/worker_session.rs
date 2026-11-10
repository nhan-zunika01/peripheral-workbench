use crate::{
    process::ProcessIdentity,
    session_guard::{GuardRecord, PreviousOutcome, WriteRisk},
    worker::WorkerRequest,
    ApiError,
};
use serde::{Deserialize, Serialize};
use std::path::Path;
pub struct WorkerAuthority<'a> {
    pub expected_guard: &'a Path,
    pub parent_image: &'a Path,
    pub companion_image: &'a Path,
}
pub fn validate_guard_path(context: &WorkerContext, expected: &Path) -> Result<(), ApiError> {
    if context.guard_path != expected {
        return Err(ApiError::new(
            403,
            "Private worker guard is not the active companion session",
        ));
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerContext {
    pub nonce: String,
    pub parent_handle: u64,
    pub guard_path: std::path::PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerEnvelope {
    pub request: WorkerRequest,
    pub session: Option<WorkerContext>,
}
// Each independent authority input is checked before the private worker opens HID.
#[allow(clippy::too_many_arguments)]
pub fn authorize(
    record: &GuardRecord,
    context: &WorkerContext,
    child: &ProcessIdentity,
    parent: &ProcessIdentity,
    parent_active: bool,
    request: &WorkerRequest,
    argv_writes: bool,
    authority: &WorkerAuthority<'_>,
) -> Result<bool, ApiError> {
    let denied = || {
        ApiError::new(
            403,
            "Private worker requires a registered live parent session",
        )
    };
    validate_guard_path(context, authority.expected_guard)?;
    if !authority
        .parent_image
        .as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&authority.companion_image.as_os_str().to_string_lossy())
    {
        return Err(denied());
    }
    record.validate().map_err(|_| denied())?;
    if record.phase != "worker-pending"
        || record.children.as_slice() != [child.clone()]
        || record.parent != *parent
        || record.parent == *child
        || context.nonce != record.nonce
        || context.parent_handle == 0
        || !parent_active
    {
        return Err(denied());
    }
    let writes = record.parent_allow_writes && argv_writes;
    if let WorkerRequest::Inspect {
        target,
        change,
        allow_writes,
        ..
    } = request
    {
        if let Some(change) = change {
            if !writes || !*allow_writes {
                return Err(ApiError::new(400, "Setting is not writable"));
            }
            if change.device_id != target.id
                || record.write_risk != WriteRisk::MayHaveWritten
                || record.affected_device_id.as_ref() != Some(&target.id)
                || record.previous_outcome
                    != Some(PreviousOutcome::Unknown {
                        device_id: target.id.clone(),
                    })
            {
                return Err(denied());
            }
        }
        return Ok(writes && *allow_writes);
    }
    Ok(false)
}
