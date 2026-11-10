use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
#[derive(Clone)]
pub struct DispatchGate {
    state: Arc<AtomicU64>,
}
#[derive(Clone)]
pub struct DispatchPermit {
    gate: DispatchGate,
    expected: u64,
}
impl Default for DispatchGate {
    fn default() -> Self {
        Self {
            state: Arc::new(AtomicU64::new(0)),
        }
    }
}
impl DispatchGate {
    pub fn removed(&self) {
        self.state.fetch_add(4, Ordering::SeqCst);
    }
    pub fn arm(&self) -> DispatchPermit {
        let mut expected = self.state.load(Ordering::SeqCst);
        loop {
            let next = expected & !3;
            match self
                .state
                .compare_exchange(expected, next, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => {
                    return DispatchPermit {
                        gate: self.clone(),
                        expected: next,
                    }
                }
                Err(actual) => expected = actual,
            }
        }
    }
    pub fn arm_at_epoch(&self, epoch: u64) -> Result<DispatchPermit, crate::ApiError> {
        let mut expected = self.state.load(Ordering::SeqCst);
        loop {
            if expected >> 2 != epoch {
                return Err(crate::ApiError::new(409,"Selected device attachment changed. Restart the companion and read a fresh baseline."));
            }
            let next = expected & !3;
            match self
                .state
                .compare_exchange(expected, next, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => {
                    return Ok(DispatchPermit {
                        gate: self.clone(),
                        expected: next,
                    })
                }
                Err(actual) => expected = actual,
            }
        }
    }
}
impl DispatchPermit {
    pub fn for_read(&self) -> DispatchPermit {
        self.gate.arm()
    }
    pub fn commit(&self) -> bool {
        self.gate
            .state
            .compare_exchange(
                self.expected,
                self.expected | 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }
    pub fn accept_completion(&self) -> bool {
        self.gate
            .state
            .compare_exchange(
                self.expected | 1,
                self.expected | 2,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }
    pub fn send_go(&self, writer: &mut impl std::io::Write) -> Result<(), crate::ApiError> {
        if !self.commit() {
            return Err(crate::ApiError::new(409,"Selected device attachment changed. Restart the companion and read a fresh baseline."));
        }
        writer
            .write_all(b"GO\n")
            .map_err(|error| crate::ApiError::internal(format!("Private worker failed: {error}")))
    }
}
