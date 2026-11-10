use crate::{
    backend::Backend,
    inventory::{resolve, snapshot_inventory, AttachmentGuard, BindingTicket, Inventory},
    session_guard::SessionGuard,
    socket::ExclusiveSocket,
    worker::{WorkerExecutor, WorkerRequest, WorkerRunner},
    ApiError, Change,
};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};
#[cfg(windows)]
pub struct PhysicalBackend<W = WorkerRunner, L = crate::windows_inventory::HidRemovalListener> {
    runner: W,
    attachment: AttachmentGuard,
    session: Option<SessionGuard>,
    allow_writes: bool,
    _listener: L,
    _socket: Arc<ExclusiveSocket>,
}
#[cfg(windows)]
impl PhysicalBackend {
    pub fn new(
        executable: PathBuf,
        allow_writes: bool,
        session: SessionGuard,
        socket: Arc<ExclusiveSocket>,
    ) -> Result<Self, ApiError> {
        Self::with_listener(
            executable,
            allow_writes,
            session,
            socket,
            crate::windows_inventory::HidRemovalListener::register,
        )
    }
}
#[cfg(windows)]
impl<L> PhysicalBackend<WorkerRunner, L> {
    pub fn with_listener(
        executable: PathBuf,
        allow_writes: bool,
        session: SessionGuard,
        socket: Arc<ExclusiveSocket>,
        register: impl FnOnce(crate::inventory::RemovalSignal) -> Result<L, String>,
    ) -> Result<Self, ApiError> {
        let allow_writes = allow_writes && session.record().parent_allow_writes;
        let (attachment, signal) = AttachmentGuard::new();
        let listener = match register(signal) {
            Ok(listener) => listener,
            Err(error) => {
                if session.record().phase == "starting"
                    && session.record().children.is_empty()
                    && session.record().write_risk
                        == crate::session_guard::WriteRisk::NoWriteStarted
                {
                    session.finish().map_err(|cleanup| {
                        ApiError::internal(format!("{error}; guard cleanup failed: {cleanup}"))
                    })?;
                }
                return Err(ApiError::internal(error));
            }
        };
        Ok(Self {
            runner: WorkerRunner::new(executable, allow_writes),
            attachment,
            session: Some(session),
            allow_writes,
            _listener: listener,
            _socket: socket,
        })
    }
}
#[cfg(windows)]
impl<W: WorkerExecutor, L> PhysicalBackend<W, L> {
    pub fn snapshot_for_recovery(&mut self, target: &str) -> Result<Value, ApiError> {
        self.snapshot_inner(Some(target), true)
    }
    fn snapshot_inner(
        &mut self,
        selected: Option<&str>,
        recovery: bool,
    ) -> Result<Value, ApiError> {
        let window = self.attachment.begin_observation();
        let inventory = self.inventory()?;
        if recovery && !inventory.identity_complete {
            if let Some(id) = selected {
                let _ = self.attachment.observe(&inventory, id, window);
            }
            return Err(ApiError::new(
                409,
                "Recovery inventory identity is incomplete; guard retained",
            ));
        }
        let target = selected
            .and_then(|id| resolve(&inventory.devices, id))
            .or_else(|| {
                if selected.is_none() {
                    inventory.devices.first()
                } else {
                    None
                }
            });
        let Some(target) = target else {
            if let Some(id) = selected {
                let _ = self.attachment.observe(&inventory, id, window);
            }
            return Ok(snapshot_inventory(&inventory, selected, |_| unreachable!()));
        };
        let _ = self.attachment.observe(&inventory, &target.id, window);
        let writable = self.allow_writes && !self.session.as_ref().unwrap().unresolved();
        let tickets = target
            .interfaces
            .iter()
            .filter(|node| node.supported())
            .map(|node| BindingTicket {
                device_id: target.id.clone(),
                endpoint: node.clone(),
                epoch: 0,
            })
            .collect();
        let mut state = if target.supported {
            let request = WorkerRequest::Inspect {
                target: target.clone(),
                tickets,
                change: None,
                allow_writes: writable,
            };
            let adapter = self.runner.execute(
                &request,
                self.session.as_mut().unwrap(),
                self.attachment.dispatch_gate().arm(),
                &mut || Ok(()),
            );
            let adapter = if recovery {
                match adapter {
                    Ok(value) if crate::recovery_snapshot::valid(&value) => Ok(value),
                    Ok(_) => {
                        return Err(ApiError::new(
                            502,
                            "Invalid recovery adapter snapshot; guard retained",
                        ))
                    }
                    Err(error) => return Err(error),
                }
            } else {
                adapter
            };
            snapshot_inventory(&inventory, selected, |_| {
                adapter.map_err(|e| e.public_message().to_owned())
            })
        } else {
            snapshot_inventory(&inventory, selected, |_| {
                Err(target.reason.clone().unwrap_or_default())
            })
        };
        self.attachment.protect_snapshot(&target.id, &mut state);
        Ok(state)
    }
    pub fn from_parts(
        runner: W,
        attachment: AttachmentGuard,
        session: SessionGuard,
        allow_writes: bool,
        listener: L,
        socket: Arc<ExclusiveSocket>,
    ) -> Self {
        let allow_writes = allow_writes && session.record().parent_allow_writes;
        Self {
            runner,
            attachment,
            session: Some(session),
            allow_writes,
            _listener: listener,
            _socket: socket,
        }
    }
    fn inventory(&mut self) -> Result<Inventory, ApiError> {
        let value = self.runner.execute(
            &WorkerRequest::Inventory,
            self.session.as_mut().unwrap(),
            self.attachment.dispatch_gate().arm(),
            &mut || Ok(()),
        )?;
        serde_json::from_value(value).map_err(|_| ApiError::internal("Invalid inventory response"))
    }
    pub fn finish_recovery(mut self, outcome: Value) -> Result<(), ApiError> {
        let guard = self.session.take().unwrap();
        guard
            .finish_recovery(outcome)
            .map_err(|e| ApiError::internal(e.to_string()))
    }
}
#[cfg(windows)]
impl<W: WorkerExecutor, L> Backend for PhysicalBackend<W, L> {
    fn validate_write(&mut self, change: &Change) -> Result<(), ApiError> {
        if !self.allow_writes {
            return Ok(());
        }
        self.attachment
            .check_selection(&change.device_id)
            .map_err(|e| ApiError::new(e.status, e.message))
    }
    fn snapshot(&mut self, selected: Option<&str>) -> Result<Value, ApiError> {
        self.snapshot_inner(selected, false)
    }
    fn apply(&mut self, change: &Change) -> Result<Value, ApiError> {
        if !self.allow_writes || self.session.as_ref().unwrap().unresolved() {
            return Err(ApiError::new(400, "Setting is not writable"));
        }
        let window = self.attachment.begin_observation();
        let inventory = self.inventory()?;
        self.attachment
            .observe(&inventory, &change.device_id, window)
            .map_err(|e| ApiError::new(e.status, e.message))?;
        let target = resolve(&inventory.devices, &change.device_id)
            .ok_or_else(|| ApiError::new(503, "Device is not connected"))?;
        if !target.supported {
            return Err(ApiError::new(
                400,
                "No verified adapter bound to this physical device",
            ));
        }
        let tickets: Vec<_> = target
            .interfaces
            .iter()
            .filter(|node| node.supported())
            .map(|node| {
                self.attachment
                    .prepare(target, &node.path)
                    .map_err(|e| ApiError::new(e.status, e.message))
            })
            .collect::<Result<_, _>>()?;
        let request = WorkerRequest::Inspect {
            target: target.clone(),
            tickets: tickets.clone(),
            change: Some(change.clone()),
            allow_writes: true,
        };
        let attachment = &mut self.attachment;
        let dispatch_gate = attachment.dispatch_gate();
        let epoch = tickets
            .first()
            .ok_or_else(|| ApiError::new(409, "Selected device attachment changed"))?
            .epoch;
        let completion = dispatch_gate.arm_at_epoch(epoch)?;
        let result = self.runner.execute(
            &request,
            self.session.as_mut().unwrap(),
            completion.clone(),
            &mut || {
                for ticket in &tickets {
                    attachment
                        .check_dispatch(ticket)
                        .map_err(|e| ApiError::new(e.status, e.message))?;
                }
                Ok(())
            },
        )?;
        if result["verified"] != true {
            return Err(ApiError::new(502, "Native operation could not be verified"));
        }
        if !completion.accept_completion() {
            return Err(ApiError::new(502,"Selected device attachment changed during the operation; its outcome is unknown. Read fresh state before recovery."));
        }
        self.session
            .as_mut()
            .unwrap()
            .confirmed()
            .map_err(|e| ApiError::internal(e.to_string()))?;
        Ok(result)
    }
    fn shutdown(&mut self) -> Result<(), ApiError> {
        if let Some(guard) = self.session.take() {
            if guard.unresolved() {
                return Err(ApiError::new(
                    502,
                    "A write outcome is unknown; guard retained for explicit read-only recovery",
                ));
            }
            guard
                .finish()
                .map_err(|e| ApiError::internal(e.to_string()))?;
        }
        Ok(())
    }
}
#[cfg(not(windows))]
pub fn unsupported() -> ApiError {
    ApiError::new(502, "Windows physical backend required")
}
