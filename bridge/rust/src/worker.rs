use crate::{
    inventory::{BindingTicket, Device},
    process,
    session_guard::SessionGuard,
    ApiError, Change,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::{self, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

pub const INPUT_LIMIT: usize = 16_384;
pub const OUTPUT_LIMIT: usize = 262_144;
pub const INVENTORY_LIMIT: usize = 1_048_576;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
// The single bounded IPC frame owns its target and validated change together.
#[allow(clippy::large_enum_variant)]
pub enum WorkerRequest {
    Inventory,
    Inspect {
        target: Device,
        tickets: Vec<BindingTicket>,
        change: Option<Change>,
        allow_writes: bool,
    },
}
impl WorkerRequest {
    pub fn write_target(&self) -> Option<&str> {
        match self {
            Self::Inspect {
                target,
                change: Some(_),
                ..
            } => Some(&target.id),
            _ => None,
        }
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerResponse {
    pub result: Result<Value, ApiError>,
}
pub fn read_frame(reader: &mut impl Read, limit: usize) -> io::Result<Vec<u8>> {
    let mut prefix = [0; 4];
    reader.read_exact(&mut prefix)?;
    let size = u32::from_le_bytes(prefix) as usize;
    if size > limit {
        return Err(io::Error::other("Private worker frame too large"));
    }
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes)?;
    Ok(bytes)
}
pub fn write_frame(writer: &mut impl Write, bytes: &[u8], limit: usize) -> io::Result<()> {
    if bytes.len() > limit {
        return Err(io::Error::other("Private worker frame too large"));
    }
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
    writer.write_all(bytes)?;
    writer.flush()
}
pub fn receive_request(reader: &mut impl Read) -> io::Result<WorkerRequest> {
    Ok(receive_envelope(reader)?.request)
}
pub fn receive_envelope(
    reader: &mut impl Read,
) -> io::Result<crate::worker_session::WorkerEnvelope> {
    let request = prepare_envelope(reader)?;
    receive_go(reader)?;
    Ok(request)
}
pub fn prepare_envelope(
    reader: &mut impl Read,
) -> io::Result<crate::worker_session::WorkerEnvelope> {
    let bytes = read_frame(reader, INPUT_LIMIT)?;
    crate::JsValue::parse(&bytes).map_err(io::Error::other)?;
    let request = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    Ok(request)
}
pub fn receive_go(reader: &mut impl Read) -> io::Result<()> {
    let mut go = [0; 3];
    reader.read_exact(&mut go)?;
    if &go != b"GO\n" {
        return Err(io::Error::other("Missing private worker GO"));
    }
    let mut trailing = [0];
    if reader.read(&mut trailing)? != 0 {
        return Err(io::Error::other("Extra private worker input"));
    }
    Ok(())
}
pub struct WorkerRunner {
    executable: PathBuf,
    allow_writes: bool,
    inventory_deadline: Duration,
    hid_deadline: Duration,
}
pub trait WorkerExecutor {
    fn execute(
        &self,
        request: &WorkerRequest,
        guard: &mut SessionGuard,
        permit: crate::dispatch::DispatchPermit,
        before_go: &mut (dyn FnMut() -> Result<(), ApiError> + Send),
    ) -> Result<Value, ApiError>;
}
impl WorkerExecutor for WorkerRunner {
    fn execute(
        &self,
        request: &WorkerRequest,
        guard: &mut SessionGuard,
        permit: crate::dispatch::DispatchPermit,
        before_go: &mut (dyn FnMut() -> Result<(), ApiError> + Send),
    ) -> Result<Value, ApiError> {
        #[cfg(windows)]
        {
            self.run_guarded(request, guard, before_go, permit, process::Job::assign)
        }
        #[cfg(not(windows))]
        {
            let _ = permit;
            self.run(request, guard, before_go)
        }
    }
}
impl WorkerRunner {
    pub fn new(executable: PathBuf, allow_writes: bool) -> Self {
        Self {
            executable,
            allow_writes,
            inventory_deadline: Duration::from_secs(12),
            hid_deadline: Duration::from_secs(9),
        }
    }
    pub fn with_deadlines(mut self, inventory: Duration, hid: Duration) -> Self {
        self.inventory_deadline = inventory;
        self.hid_deadline = hid;
        self
    }
    #[cfg(windows)]
    pub fn run(
        &self,
        request: &WorkerRequest,
        guard: &mut SessionGuard,
        before_go: impl FnOnce() -> Result<(), ApiError> + Send,
    ) -> Result<Value, ApiError> {
        self.run_with_job_factory(request, guard, before_go, process::Job::assign)
    }
    #[cfg(windows)]
    pub fn run_with_job_factory(
        &self,
        request: &WorkerRequest,
        guard: &mut SessionGuard,
        before_go: impl FnOnce() -> Result<(), ApiError> + Send,
        assign_job: impl FnOnce(&std::process::Child) -> io::Result<process::Job>,
    ) -> Result<Value, ApiError> {
        self.run_guarded(
            request,
            guard,
            before_go,
            crate::dispatch::DispatchGate::default().arm(),
            assign_job,
        )
    }
    #[cfg(windows)]
    fn run_guarded(
        &self,
        request: &WorkerRequest,
        guard: &mut SessionGuard,
        before_go: impl FnOnce() -> Result<(), ApiError> + Send,
        permit: crate::dispatch::DispatchPermit,
        assign_job: impl FnOnce(&std::process::Child) -> io::Result<process::Job>,
    ) -> Result<Value, ApiError> {
        use std::os::windows::process::CommandExt;
        let failure =
            |error: io::Error| ApiError::internal(format!("Private worker failed: {error}"));
        let mut request = request.clone();
        let parent_writes = self.allow_writes && guard.record().parent_allow_writes;
        if request.write_target().is_some() && !parent_writes {
            return Err(ApiError::new(400, "Setting is not writable"));
        }
        if request.write_target().is_some() && guard.unresolved() {
            return Err(ApiError::new(
                409,
                "An earlier write requires explicit read-only recovery",
            ));
        }
        if let WorkerRequest::Inspect {
            allow_writes,
            change,
            target,
            ..
        } = &mut request
        {
            *allow_writes &= parent_writes;
            if change
                .as_ref()
                .is_some_and(|change| change.device_id != target.id)
            {
                return Err(ApiError::new(409, "Selected device identity changed"));
            }
            if change.is_some() && !*allow_writes {
                return Err(ApiError::new(400, "Setting is not writable"));
            }
        }
        let mut envelope = crate::worker_session::WorkerEnvelope {
            request,
            session: Some(crate::worker_session::WorkerContext {
                nonce: guard.record().nonce.clone(),
                parent_handle: u64::MAX,
                guard_path: guard.path().to_owned(),
            }),
        };
        let bytes = serde_json::to_vec(&envelope)
            .map_err(|_| ApiError::new(400, "Invalid worker request"))?;
        if bytes.len() > INPUT_LIMIT {
            return Err(ApiError::new(400, "Private worker request too large"));
        }
        let inventory = matches!(envelope.request, WorkerRequest::Inventory);
        let limit = if inventory {
            INVENTORY_LIMIT
        } else {
            OUTPUT_LIMIT
        };
        let deadline = Instant::now()
            + if inventory {
                self.inventory_deadline
            } else {
                self.hid_deadline
            };
        guard.spawning().map_err(failure)?;
        let mut child = Command::new(&self.executable)
            .args([
                "--internal-worker",
                if parent_writes {
                    "--allow-writes"
                } else {
                    "--read-only"
                },
            ])
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                let _ = guard.spawn_failed_or_reaped();
                failure(error)
            })?;
        let job = match assign_job(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                child.wait().map_err(failure)?;
                guard.spawn_failed_or_reaped().map_err(failure)?;
                return Err(failure(error));
            }
        };
        let identity = match process::child_identity(&child) {
            Ok(id) => id,
            Err(error) => {
                job.terminate();
                let _ = child.kill();
                child.wait().map_err(failure)?;
                guard.spawn_failed_or_reaped().map_err(failure)?;
                return Err(failure(error));
            }
        };
        if let Err(error) = guard.register(identity.clone(), envelope.request.write_target()) {
            job.terminate();
            let _ = child.kill();
            child.wait().map_err(failure)?;
            return Err(failure(error));
        }
        let parent_handle = match process::duplicate_parent(&child) {
            Ok(handle) => handle,
            Err(error) => {
                job.terminate();
                let _ = child.kill();
                child.wait().map_err(failure)?;
                guard.retire(&identity).map_err(failure)?;
                return Err(failure(error));
            }
        };
        envelope.session.as_mut().unwrap().parent_handle = parent_handle;
        let bytes = serde_json::to_vec(&envelope)
            .map_err(|_| ApiError::new(400, "Invalid worker request"))?;
        let mut input = child.stdin.take().unwrap();
        let write_request = envelope.request.write_target().is_some();
        let mut output = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        let write_tx = tx.clone();
        std::thread::scope(|scope| {
            let writer = scope.spawn(move || {
            let result=write_frame(&mut input,&bytes,INPUT_LIMIT).map_err(failure).and_then(|_| {
                let permit=if write_request {permit} else {permit.for_read()};

                before_go()?;
                if Instant::now()>=deadline {return Err(ApiError::new(504,"Native worker timed out; reconnect and read fresh state before making another change"))}
                permit.send_go(&mut input)
            });
            if let Err(error) = result {
                let _ = write_tx.send(Err(error));
            }
            drop(input);
        });
            let reader = std::thread::spawn(move || {
                let result = read_frame(&mut output, limit).and_then(|bytes| {
                    let mut trailing = [0];
                    if output.read(&mut trailing)? != 0 {
                        return Err(io::Error::other("Extra private worker response"));
                    }
                    Ok(bytes)
                });
                let _ = tx.send(result.map_err(failure));
            });
            let mut response = None;
            let mut error = None;
            let mut status = None;
            loop {
                if Instant::now() >= deadline {
                    error=Some(ApiError::new(504,"Native worker timed out; reconnect and read fresh state before making another change"));
                    break;
                }
                if response.is_none() {
                    if let Ok(result) = rx.try_recv() {
                        match result {
                            Ok(bytes) => response = Some(bytes),
                            Err(e) => error = Some(e),
                        }
                    }
                }
                match child.try_wait() {
                    Ok(Some(exit)) => {
                        status = Some(exit);
                        break;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        error = Some(failure(e));
                        break;
                    }
                }
                if error.is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(3));
            }
            if error.is_some() {
                job.terminate();
                let _ = child.kill();
            }
            let exit = match status {
                Some(status) => status,
                None => child.wait().map_err(failure)?,
            };
            // Keep ownership until both process exit and all inherited private pipe handles close.
            job.terminate();
            let _ = writer.join();
            let _ = reader.join();
            guard.retire(&identity).map_err(failure)?;
            if let Some(error) = error {
                return Err(error);
            }
            if !exit.success() {
                return Err(ApiError::internal("Private worker exited unsuccessfully"));
            }
            let bytes = match response {
                Some(bytes) => bytes,
                None => rx
                    .recv()
                    .map_err(|_| ApiError::internal("Missing private worker response"))??,
            };
            crate::JsValue::parse(&bytes)
                .map_err(|_| ApiError::internal("Invalid private worker response"))?;
            let response: WorkerResponse = serde_json::from_slice(&bytes)
                .map_err(|_| ApiError::internal("Invalid private worker response"))?;
            response.result
        })
    }
    #[cfg(not(windows))]
    pub fn run(
        &self,
        _: &WorkerRequest,
        _: &mut SessionGuard,
        _: impl FnOnce() -> Result<(), ApiError>,
    ) -> Result<Value, ApiError> {
        Err(ApiError::internal("Windows Job Objects required"))
    }
}
