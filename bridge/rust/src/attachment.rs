use super::*;
use crate::dispatch::DispatchGate;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc,
    },
};

#[derive(Clone)]
pub struct RemovalSignal {
    epoch: Arc<AtomicU64>,
    events: mpsc::Sender<(u64, String)>,
    dispatch_gate: DispatchGate,
}

impl RemovalSignal {
    // Callback only queues data and advances an epoch; collection happens in the parent.
    pub fn removed(&self, path: &str) {
        self.dispatch_gate.removed();
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.events.send((epoch, path.to_lowercase()));
    }
}

pub struct AttachmentGuard {
    epoch: Arc<AtomicU64>,
    dispatch_gate: DispatchGate,
    events: mpsc::Receiver<(u64, String)>,
    paths: BTreeMap<String, (u64, Vec<String>)>,
    bindings: BTreeMap<String, BTreeSet<(String, u16, i32, u16)>>,
    stale: BTreeSet<String>,
    removed_paths: BTreeMap<String, u64>,
    processed_epoch: u64,
    pending_epochs: BTreeSet<u64>,
    window_counter: u64,
    active_window: u64,
    unverified: BTreeSet<String>,
}

pub struct ObservationWindow {
    owner: Arc<AtomicU64>,
    epoch: u64,
    sequence: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BindingTicket {
    pub device_id: String,
    pub endpoint: HidNode,
    pub epoch: u64,
}

#[derive(Debug, PartialEq)]
pub struct BindingError {
    pub status: u16,
    pub message: String,
}

fn binding_error() -> BindingError {
    BindingError {
        status: 409,
        message:
            "Selected device attachment changed. Restart the companion and read a fresh baseline."
                .into(),
    }
}

impl AttachmentGuard {
    pub fn new() -> (Self, RemovalSignal) {
        let epoch = Arc::new(AtomicU64::new(0));
        let (tx, rx) = mpsc::channel();
        let dispatch_gate = DispatchGate::default();
        (
            Self {
                epoch: epoch.clone(),
                dispatch_gate: dispatch_gate.clone(),
                events: rx,
                paths: BTreeMap::new(),
                bindings: BTreeMap::new(),
                stale: BTreeSet::new(),
                removed_paths: BTreeMap::new(),
                processed_epoch: 0,
                pending_epochs: BTreeSet::new(),
                window_counter: 0,
                active_window: 0,
                unverified: BTreeSet::new(),
            },
            RemovalSignal {
                epoch,
                events: tx,
                dispatch_gate,
            },
        )
    }

    pub fn dispatch_gate(&self) -> DispatchGate {
        self.dispatch_gate.clone()
    }

    fn sync(&mut self) {
        for (epoch, removed) in self.events.try_iter() {
            for (id, (baseline_epoch, paths)) in &self.paths {
                if epoch > *baseline_epoch && paths.contains(&removed) {
                    self.stale.insert(id.clone());
                }
            }
            self.removed_paths
                .entry(removed)
                .and_modify(|old| *old = (*old).max(epoch))
                .or_insert(epoch);
            self.pending_epochs.insert(epoch);
        }
        while self.pending_epochs.remove(&(self.processed_epoch + 1)) {
            self.processed_epoch += 1;
        }
    }

    // Capture immediately before enumeration; the token is parent-owned and consumed once.
    pub fn begin_observation(&mut self) -> ObservationWindow {
        self.sync();
        self.window_counter += 1;
        self.active_window = self.window_counter;
        ObservationWindow {
            owner: self.epoch.clone(),
            epoch: self.epoch.load(Ordering::SeqCst),
            sequence: self.active_window,
        }
    }

    pub fn observe(
        &mut self,
        inventory: &Inventory,
        selected_id: &str,
        window: ObservationWindow,
    ) -> Result<(), BindingError> {
        self.sync();
        if !Arc::ptr_eq(&window.owner, &self.epoch)
            || window.sequence != self.active_window
            || self.active_window == 0
        {
            self.unverified.insert(selected_id.into());
            return Err(binding_error());
        }
        self.active_window = 0;
        if !inventory.identity_complete {
            self.unverified.insert(selected_id.into());
            return Err(binding_error());
        }
        self.unverified.remove(selected_id);
        match resolve(&inventory.devices, selected_id) {
            Some(device) => {
                let paths: Vec<_> = device
                    .interfaces
                    .iter()
                    .map(|h| h.path.to_lowercase())
                    .collect();
                if paths.iter().any(|p| {
                    self.removed_paths
                        .get(p)
                        .is_some_and(|epoch| *epoch > window.epoch)
                }) {
                    self.stale.insert(selected_id.into());
                }
                let binding = device
                    .interfaces
                    .iter()
                    .map(|h| {
                        (
                            h.path.to_lowercase(),
                            h.product_id,
                            h.interface_number,
                            h.vendor_id,
                        )
                    })
                    .collect();
                if self
                    .bindings
                    .get(selected_id)
                    .is_some_and(|previous| previous != &binding)
                {
                    self.stale.insert(selected_id.into());
                }
                self.bindings.entry(selected_id.into()).or_insert(binding);
                self.paths
                    .entry(selected_id.into())
                    .or_insert((window.epoch, paths));
            }
            None => {
                self.stale.insert(selected_id.into());
            }
        }
        Ok(())
    }

    pub fn prepare(&mut self, device: &Device, path: &str) -> Result<BindingTicket, BindingError> {
        self.check_selection(&device.id)?;
        let endpoint = device
            .interfaces
            .iter()
            .find(|h| h.path == path && h.supported())
            .ok_or_else(binding_error)?;
        let binding = (
            endpoint.path.to_lowercase(),
            endpoint.product_id,
            endpoint.interface_number,
            endpoint.vendor_id,
        );
        if !self
            .bindings
            .get(&device.id)
            .is_some_and(|original| original.contains(&binding))
        {
            self.stale.insert(device.id.clone());
            return Err(binding_error());
        }
        Ok(BindingTicket {
            device_id: device.id.clone(),
            endpoint: endpoint.clone(),
            epoch: self.epoch.load(Ordering::SeqCst),
        })
    }

    pub fn check_selection(&mut self, device_id: &str) -> Result<(), BindingError> {
        self.sync();
        if self.stale.contains(device_id)
            || self.unverified.contains(device_id)
            || !self.paths.contains_key(device_id)
            || self.processed_epoch != self.epoch.load(Ordering::SeqCst)
        {
            return Err(binding_error());
        }
        Ok(())
    }

    // Call immediately before private worker GO; after GO an event makes the result uncertain.
    pub fn check_dispatch(&mut self, ticket: &BindingTicket) -> Result<(), BindingError> {
        self.sync();
        if self.stale.contains(&ticket.device_id)
            || self.unverified.contains(&ticket.device_id)
            || self.processed_epoch != self.epoch.load(Ordering::SeqCst)
            || ticket.epoch != self.epoch.load(Ordering::SeqCst)
        {
            Err(binding_error())
        } else {
            Ok(())
        }
    }

    pub fn protect_snapshot(&mut self, selected_id: &str, snapshot: &mut Value) {
        self.sync();
        if self.stale.contains(selected_id)
            || self.unverified.contains(selected_id)
            || self.processed_epoch != self.epoch.load(Ordering::SeqCst)
        {
            if let Some(settings) = snapshot["settings"].as_array_mut() {
                for schema in settings {
                    schema["writable"] = false.into();
                }
            }
        }
    }
}

pub fn verified_open<T>(
    collect: impl FnOnce() -> Result<Inventory, String>,
    ticket: &BindingTicket,
    open: impl FnOnce(&HidNode) -> Result<T, String>,
) -> Result<T, BindingError> {
    let inventory = collect().map_err(|_| binding_error())?;
    if !inventory.identity_complete {
        return Err(binding_error());
    }
    let selected = resolve(&inventory.devices, &ticket.device_id).ok_or_else(binding_error)?;
    let endpoint = selected
        .interfaces
        .iter()
        .find(|h| {
            h.supported()
                && h.path == ticket.endpoint.path
                && h.product_id == ticket.endpoint.product_id
                && h.interface_number == ticket.endpoint.interface_number
        })
        .ok_or_else(binding_error)?;
    open(endpoint).map_err(|message| BindingError {
        status: 502,
        message,
    })
}

#[cfg(test)]
mod callback_tests {
    use super::*;

    fn inventory() -> Inventory {
        let hid: Vec<HidNode> = serde_json::from_value(serde_json::json!([
            {"path":"unit-a","vendorId":5426,"productId":223,"interface":0},
            {"path":"unit-b","vendorId":5426,"productId":223,"interface":0}
        ]))
        .unwrap();
        collect_results(Ok(hid), Ok(vec![]))
    }

    #[test]
    fn delayed_old_unselected_event_does_not_poison_its_new_baseline() {
        let inv = inventory();
        let (a, b) = (&inv.devices[0], &inv.devices[1]);
        let (mut guard, signal) = AttachmentGuard::new();
        let first = guard.begin_observation();
        guard.observe(&inv, &a.id, first).unwrap();
        let epoch = signal.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let fresh = guard.begin_observation();
        guard.observe(&inv, &b.id, fresh).unwrap();
        assert!(
            guard.prepare(b, &b.interfaces[0].path).is_err(),
            "pending delivery must block writes"
        );
        signal
            .events
            .send((epoch, b.interfaces[0].path.to_lowercase()))
            .unwrap();
        assert!(
            guard.prepare(b, &b.interfaces[0].path).is_ok(),
            "old B removal predates its fresh baseline"
        );
    }

    #[test]
    fn pending_callback_projects_read_only_before_and_after_selected_delivery() {
        let inv = inventory();
        let a = &inv.devices[0];
        let (mut guard, signal) = AttachmentGuard::new();
        let window = guard.begin_observation();
        let epoch = signal.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        guard.observe(&inv, &a.id, window).unwrap();
        let snapshot = || serde_json::json!({"settings":[{"id":"dpi","writable":true}]});
        let mut before = snapshot();
        guard.protect_snapshot(&a.id, &mut before);
        assert_eq!(
            before["settings"][0]["writable"], false,
            "pending epoch must project read-only"
        );
        assert!(guard.prepare(a, &a.interfaces[0].path).is_err());
        signal
            .events
            .send((epoch, a.interfaces[0].path.to_lowercase()))
            .unwrap();
        let mut after = snapshot();
        guard.protect_snapshot(&a.id, &mut after);
        assert_eq!(after["settings"][0]["writable"], false);
        assert!(guard.prepare(a, &a.interfaces[0].path).is_err());
    }
}
