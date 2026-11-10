use crate::{
    backend::{transact, Backend},
    ApiError, Change,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{mpsc, Arc, Mutex},
    thread::JoinHandle,
    time::Duration,
};
use tokio::sync::watch;
type ResultValue = Result<Value, ApiError>;
type Sender = watch::Sender<Option<ResultValue>>;
enum Work {
    Read(Option<String>, Sender),
    Write(Change, Sender),
    Shutdown(mpsc::Sender<Result<(), ApiError>>),
}
struct State {
    active: usize,
    closed: bool,
    reads: BTreeMap<Option<String>, watch::Receiver<Option<ResultValue>>>,
}
pub struct Coordinator {
    tx: mpsc::Sender<Work>,
    state: Arc<Mutex<State>>,
    thread: Mutex<Option<JoinHandle<()>>>,
    shutdown_result: Mutex<Option<Result<(), ApiError>>>,
}
#[derive(Debug)]
pub struct Reply {
    rx: watch::Receiver<Option<ResultValue>>,
}
impl Reply {
    pub async fn result(mut self) -> ResultValue {
        self.with_deadline(Duration::from_secs(75)).await
    }
    pub async fn with_deadline(&mut self, deadline: Duration) -> ResultValue {
        tokio::time::timeout(deadline, async {
            loop {
                if let Some(value) = self.rx.borrow().clone() {
                    return value;
                }
                self.rx
                    .changed()
                    .await
                    .map_err(|_| ApiError::internal("Backend task ended without a result"))?;
            }
        })
        .await
        .map_err(|_| {
            ApiError::new(
                504,
                "Device operation timed out. Inspect the companion before retrying.",
            )
        })?
    }
}
impl Coordinator {
    pub fn start(
        factory: impl FnOnce() -> Result<Box<dyn Backend>, ApiError> + Send + 'static,
    ) -> Result<Self, ApiError> {
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(State {
            active: 0,
            closed: false,
            reads: BTreeMap::new(),
        }));
        let owned = state.clone();
        let thread = std::thread::spawn(move || {
            let mut backend = match factory() {
                Ok(backend) => {
                    let _ = ready_tx.send(Ok(()));
                    backend
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            for work in rx {
                let (key, reply, result) = match work {
                    Work::Read(id, reply) => {
                        let result = backend.snapshot(id.as_deref());
                        (Some(id), reply, result)
                    }
                    Work::Write(change, reply) => {
                        (None, reply, transact(backend.as_mut(), &change))
                    }
                    Work::Shutdown(reply) => {
                        let _ = reply.send(backend.shutdown());
                        break;
                    }
                };
                {
                    let mut state = owned.lock().unwrap();
                    state.active -= 1;
                    if let Some(key) = key {
                        state.reads.remove(&key);
                    }
                }
                let _ = reply.send(Some(result));
            }
        });
        ready_rx
            .recv()
            .map_err(|_| ApiError::internal("Backend initialization failed"))??;
        Ok(Self {
            tx,
            state,
            thread: Mutex::new(Some(thread)),
            shutdown_result: Mutex::new(None),
        })
    }
    pub fn read(&self, id: Option<String>) -> Result<Reply, ApiError> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(ApiError::new(503, "Companion is stopping"));
        }
        if let Some(rx) = state.reads.get(&id) {
            return Ok(Reply { rx: rx.clone() });
        }
        let (tx, rx) = watch::channel(None);
        state.reads.insert(id.clone(), rx.clone());
        state.active += 1;
        self.tx
            .send(Work::Read(id, tx))
            .map_err(|_| ApiError::internal("Backend is unavailable"))?;
        Ok(Reply { rx })
    }
    pub fn write(&self, change: Change) -> Result<Reply, ApiError> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(ApiError::new(503, "Companion is stopping"));
        }
        if state.active > 0 {
            return Err(ApiError::new(
                409,
                "A device operation is already in progress",
            ));
        }
        let (tx, rx) = watch::channel(None);
        state.active += 1;
        self.tx
            .send(Work::Write(change, tx))
            .map_err(|_| ApiError::internal("Backend is unavailable"))?;
        Ok(Reply { rx })
    }
    pub fn stop_dispatch(&self) {
        self.state.lock().unwrap().closed = true;
    }
    pub fn shutdown(&self) -> Result<(), ApiError> {
        let mut previous = self.shutdown_result.lock().unwrap();
        if let Some(result) = previous.as_ref() {
            return result.clone();
        }
        let result = (|| {
            let (tx, rx) = mpsc::channel();
            {
                let mut state = self.state.lock().unwrap();
                state.closed = true;
                self.tx
                    .send(Work::Shutdown(tx))
                    .map_err(|_| ApiError::internal("Backend is unavailable"))?;
            }
            let result = rx
                .recv()
                .map_err(|_| ApiError::internal("Backend shutdown failed"))?;
            if let Some(thread) = self.thread.lock().unwrap().take() {
                thread
                    .join()
                    .map_err(|_| ApiError::internal("Backend task panicked"))?;
            }
            result
        })();
        *previous = Some(result.clone());
        result
    }
}
impl Drop for Coordinator {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}
