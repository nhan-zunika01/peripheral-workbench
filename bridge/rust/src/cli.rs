use crate::session_guard::valid_id;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Options {
    pub origin: String,
    pub allow_writes: bool,
    pub recover: bool,
    pub acknowledge: bool,
    pub device_id: Option<String>,
    pub internal: bool,
    pub managed_shutdown: bool,
}
pub fn validate_environment(inspector: Option<&str>) -> Result<(), String> {
    if inspector.is_some() {
        Err("SYNAPSE_INSPECTOR_URL is incompatible with the Rust companion".into())
    } else {
        Ok(())
    }
}
#[cfg(windows)]
async fn interrupted(signal: &mut tokio::signal::windows::CtrlC) -> bool {
    tokio::select! {biased; _=signal.recv()=>true,_=std::future::ready(())=>false}
}
pub fn parse(args: &[String], environment_origin: Option<&str>) -> Result<Options, String> {
    let mut options = Options {
        origin: environment_origin.unwrap_or("http://127.0.0.1:8787").into(),
        allow_writes: false,
        recover: false,
        acknowledge: false,
        device_id: None,
        internal: false,
        managed_shutdown: false,
    };
    let mut read_only = false;
    let mut seen = std::collections::BTreeSet::new();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if !seen.insert(arg) {
            return Err("Duplicate companion option".into());
        }
        match arg.as_str() {
            "--origin" => options.origin = args.next().ok_or("Missing origin")?.clone(),
            "--device-id" => {
                options.device_id = Some(
                    args.next()
                        .filter(|id| valid_id(id))
                        .ok_or("Invalid device identity")?
                        .clone(),
                )
            }
            "--allow-writes" => options.allow_writes = true,
            "--read-only" => read_only = true,
            "--recover-read-only" => options.recover = true,
            "--acknowledge-unresolved" => options.acknowledge = true,
            "--internal-worker" => options.internal = true,
            "--managed-shutdown" => options.managed_shutdown = true,
            _ => return Err("Unknown companion option".into()),
        }
    }
    if options.managed_shutdown && (options.internal || options.recover) {
        return Err("Managed shutdown is only valid for the normal HTTP server".into());
    }
    if options.internal
        && (options.recover
            || options.acknowledge
            || options.device_id.is_some()
            || seen.contains(&"--origin".to_string()))
    {
        return Err("Invalid private worker arguments".into());
    }
    if !options.recover && (options.acknowledge || options.device_id.is_some()) {
        return Err("Recovery option requires --recover-read-only".into());
    }
    if read_only || options.recover {
        options.allow_writes = false;
    }
    let origin = url::Url::parse(&options.origin).map_err(|_| "Invalid UI origin")?;
    if !["http", "https"].contains(&origin.scheme())
        || origin.origin().ascii_serialization() != options.origin
    {
        return Err("Expected an exact HTTP(S) UI origin".into());
    }
    Ok(options)
}
#[cfg(windows)]
pub async fn run(options: Options) -> Result<(), Box<dyn std::error::Error>> {
    use crate::{
        physical_backend::PhysicalBackend,
        process::NativeProcessTable,
        recovery::{self, ReadPlan},
        session_guard::sentinel_path,
    };
    validate_environment(std::env::var("SYNAPSE_INSPECTOR_URL").ok().as_deref())?;
    if options.internal {
        crate::worker_native::run(options.allow_writes)?;
        return Ok(());
    }
    let mut signal = tokio::signal::windows::ctrl_c()?;
    let path = sentinel_path()?;
    let executable = std::env::current_exe()?;
    if options.recover {
        let resources = recovery::begin(path, 17321, &mut NativeProcessTable)?;
        if interrupted(&mut signal).await {
            return Err("Recovery stopped before inspection; guard retained".into());
        }
        let plan = recovery::read_plan(
            resources.guard.record(),
            options.device_id.as_deref(),
            options.acknowledge,
        )?;
        if matches!(plan, ReadPlan::NoWrite | ReadPlan::UnknownAcknowledgement) {
            let outcome =
                recovery::outcome(resources.guard.record(), &plan, options.acknowledge, None)?;
            resources.guard.finish_recovery(outcome)?;
            return Ok(());
        }
        let record = resources.guard.record().clone();
        let ReadPlan::Target(target) = &plan else {
            unreachable!()
        };
        if !options.acknowledge {
            let socket = resources.socket.clone();
            let target = target.clone();
            let (stop_tx, stop_rx) = std::sync::mpsc::sync_channel(1);
            let coordinator = std::sync::Arc::new(crate::coordinator::Coordinator::start(
                move || {
                    let mut backend =
                        PhysicalBackend::new(executable, false, resources.guard, resources.socket)?;
                    let state = backend.snapshot_for_recovery(&target)?;
                    recovery::outcome(
                        &record,
                        &ReadPlan::Target(target.clone()),
                        false,
                        Some(&state),
                    )
                    .map_err(|e| crate::ApiError::internal(e.to_string()))?;
                    let session = crate::recovery_http::RecoveryBackend::new(
                        RecoveryPhysical(backend),
                        target,
                        |backend: RecoveryPhysical, outcome| backend.0.finish_recovery(outcome),
                        |state: &serde_json::Value| {
                            use std::io::Write;
                            let stdout = std::io::stdout();
                            let mut output = stdout.lock();
                            writeln!(output,"Read-only recovery state: {state}").and_then(|_|writeln!(output,"Inspect the affected device state above, then press Ctrl+C to record observation and close recovery.")).and_then(|_|output.flush()).map_err(|error|crate::ApiError::internal(error.to_string()))
                        },
                    );
                    let _ = stop_tx.send(session.operator_stop());
                    Ok(Box::new(session))
                },
            )?);
            let operator_stop = stop_rx.recv()?;
            if interrupted(&mut signal).await {
                return Err("Recovery stopped before inspection; guard retained".into());
            }
            let listener = tokio::net::TcpListener::from_std(socket.http_listener()?)?;
            let app = std::sync::Arc::new(crate::http::HttpApp::new(
                options.origin.clone(),
                crate::http::new_token()?,
                17321,
                false,
                coordinator,
            )?);
            println!("Read-only recovery listening at http://127.0.0.1:17321 for {}. Open the interface and read the affected device before pressing Ctrl+C.",options.origin);
            crate::http_server::serve(listener, app, async {
                signal.recv().await;
                operator_stop.store(true, std::sync::atomic::Ordering::SeqCst);
            })
            .await?;
            drop(resources.lock);
            return Ok(());
        }
        let mut backend =
            PhysicalBackend::new(executable, false, resources.guard, resources.socket)?;
        let state = backend.snapshot_for_recovery(target)?;
        let outcome = recovery::outcome(&record, &plan, true, Some(&state))?;
        backend.finish_recovery(outcome)?;
        drop(resources.lock);
        return Ok(());
    }
    let (guard, socket) = recovery::normal_session_with_mode(path, 17321, options.allow_writes)?;
    let listener_socket = socket.clone();
    let coordinator = std::sync::Arc::new(crate::coordinator::Coordinator::start(move || {
        Ok(Box::new(PhysicalBackend::new(
            executable,
            options.allow_writes,
            guard,
            socket,
        )?))
    })?);
    let listener = tokio::net::TcpListener::from_std(listener_socket.http_listener()?)?;
    let app = std::sync::Arc::new(crate::http::HttpApp::new(
        options.origin.clone(),
        crate::http::new_token()?,
        17321,
        options.allow_writes,
        coordinator,
    )?);
    println!(
        "Companion listening at http://127.0.0.1:17321 for {}",
        options.origin
    );
    let mut stop_result = Ok(());
    crate::http_server::serve(listener, app, async {
        stop_result = if options.managed_shutdown {
            tokio::select! {
                _=signal.recv()=>Ok(()),
                result=managed_shutdown(std::io::stdin())=>result,
            }
        } else {
            signal.recv().await;
            Ok(())
        };
    })
    .await?;
    stop_result?;
    Ok(())
}

pub async fn managed_shutdown(reader: impl std::io::Read + Send + 'static) -> std::io::Result<()> {
    use std::io::{BufRead, BufReader, Error, ErrorKind};
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // A detached reader must not hold Tokio shutdown open after direct Ctrl+C.
    std::thread::Builder::new()
        .name("launcher-shutdown".into())
        .spawn(move || {
            let result = (|| {
                let mut frame = Vec::new();
                BufReader::new(reader.take(9)).read_until(b'\n', &mut frame)?;
                if frame.is_empty() || frame == b"shutdown\n" {
                    Ok(())
                } else {
                    Err(Error::new(
                        ErrorKind::InvalidData,
                        "Invalid managed shutdown frame",
                    ))
                }
            })();
            let _ = sender.send(result);
        })?;
    receiver
        .await
        .map_err(|_| Error::other("Managed shutdown monitor stopped"))?
}
#[cfg(windows)]
struct RecoveryPhysical(crate::physical_backend::PhysicalBackend);
#[cfg(windows)]
impl crate::backend::Backend for RecoveryPhysical {
    fn snapshot(&mut self, id: Option<&str>) -> Result<serde_json::Value, crate::ApiError> {
        self.0.snapshot_for_recovery(id.unwrap())
    }
    fn apply(&mut self, _: &crate::Change) -> Result<serde_json::Value, crate::ApiError> {
        Err(crate::ApiError::new(400, "Setting is not writable"))
    }
}
#[cfg(not(windows))]
pub async fn run(_: Options) -> Result<(), Box<dyn std::error::Error>> {
    Err("Windows companion required".into())
}
