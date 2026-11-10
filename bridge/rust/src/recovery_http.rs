use crate::{backend::Backend, ApiError, Change};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
pub struct RecoveryBackend<B, F, P> {
    backend: Option<B>,
    target: String,
    outcome: Option<Value>,
    finish: Option<F>,
    operator_stop: Arc<AtomicBool>,
    publish: P,
}
impl<B, F, P> RecoveryBackend<B, F, P> {
    pub fn new(backend: B, target: String, finish: F, publish: P) -> Self {
        Self {
            backend: Some(backend),
            target,
            outcome: None,
            finish: Some(finish),
            operator_stop: Arc::new(AtomicBool::new(false)),
            publish,
        }
    }
    pub fn operator_stop(&self) -> Arc<AtomicBool> {
        self.operator_stop.clone()
    }
}
impl<
        B: Backend,
        F: FnOnce(B, Value) -> Result<(), ApiError>,
        P: FnMut(&Value) -> Result<(), ApiError>,
    > Backend for RecoveryBackend<B, F, P>
{
    fn snapshot(&mut self, id: Option<&str>) -> Result<Value, ApiError> {
        if id.is_some_and(|id| id != self.target) {
            return Err(ApiError::new(
                409,
                "Recovery is pinned to the affected device",
            ));
        }
        self.outcome = None;
        let state = self
            .backend
            .as_mut()
            .unwrap()
            .snapshot(Some(&self.target))?;
        if state["selectedDeviceId"] != self.target {
            return Err(ApiError::new(
                409,
                "Recovery read returned another device identity; guard retained",
            ));
        }
        if state["connected"] == true {
            (self.publish)(&state)?;
            if !self.operator_stop.load(Ordering::SeqCst) {
                self.outcome = Some(
                    serde_json::json!({"previousOutcome":"unknown","affectedDeviceId":self.target,"observedDeviceId":self.target}),
                );
            }
        }
        Ok(state)
    }
    fn apply(&mut self, _: &Change) -> Result<Value, ApiError> {
        Err(ApiError::new(400, "Setting is not writable"))
    }
    fn shutdown(&mut self) -> Result<(), ApiError> {
        if !self.operator_stop.load(Ordering::SeqCst) {
            return Err(ApiError::new(
                502,
                "Recovery requires clean operator shutdown; guard retained",
            ));
        }
        let outcome=self.outcome.clone().ok_or_else(||ApiError::new(502,"Recovery requires a fresh connected observation of the affected device; guard retained"))?;
        if let Some(backend) = self.backend.take() {
            (self.finish.take().unwrap())(backend, outcome)
        } else {
            Ok(())
        }
    }
}
