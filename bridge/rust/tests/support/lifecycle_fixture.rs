use razer_hid_helper::worker::{write_frame, WorkerRequest, WorkerResponse, OUTPUT_LIMIT};
use serde_json::json;
use std::{
    io::{self, Write},
    time::Duration,
};
fn main() {
    if std::env::current_exe().unwrap().file_stem().unwrap() == "no-input" {
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    if std::env::current_exe().unwrap().file_stem().unwrap() == "exit-before-go" {
        std::thread::sleep(Duration::from_millis(500));
        return;
    }
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|arg| arg == "--fixture-recovery-owner")
    {
        use razer_hid_helper::{
            process::NativeProcessTable, recovery_owner::RecoveryOwner, session_guard::RecoveryLock,
        };
        let path = std::path::PathBuf::from(&args[1]);
        let lock = RecoveryLock::acquire(&path).unwrap();
        let (_claim, _) = RecoveryOwner::claim(&path, &mut NativeProcessTable).unwrap();
        drop(lock);
        println!(
            "{}",
            json!({"ready":true,"parent":razer_hid_helper::process::current().unwrap()})
        );
        io::stdout().flush().unwrap();
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    if args.first().is_some_and(|arg| arg == "--fixture-hold") {
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    if args
        .first()
        .is_some_and(|arg| arg == "--fixture-generation")
    {
        use razer_hid_helper::{
            process::child_identity,
            session_guard::{load, SessionGuard},
        };
        let path = std::path::PathBuf::from(&args[1]);
        let phase = &args[2];
        let mut guard = if phase == "adoption" || phase == "recovery-pending" {
            SessionGuard::adopt(
                path.clone(),
                load(&path).unwrap(),
                vec![json!({"fixture":"old-generation-exited"})],
            )
            .unwrap()
        } else {
            SessionGuard::create_at(path).unwrap()
        };
        if phase == "spawning" {
            guard.spawning().unwrap();
        }
        let _child = if phase != "adoption" {
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("--fixture-hold")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let identity = child_identity(&child).unwrap();
            if phase != "spawning" {
                guard.register(identity.clone(), None).unwrap();
            }
            println!("{}", json!({"child":identity,"nonce":guard.record().nonce}));
            Some(child)
        } else {
            println!("{}", json!({"child":null,"nonce":guard.record().nonce}));
            None
        };
        io::stdout().flush().unwrap();
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    let mut input = io::stdin().lock();
    let Ok(envelope) = razer_hid_helper::worker::prepare_envelope(&mut input) else {
        return;
    };
    if let WorkerRequest::Inspect { target, .. } = &envelope.request {
        if target.name == "frame-observer" {
            std::fs::write(target.reason.as_ref().unwrap(), b"prepared").unwrap();
        }
    }
    if razer_hid_helper::worker::receive_go(&mut input).is_err() {
        return;
    }
    let request = envelope.request;
    let mode = match &request {
        WorkerRequest::Inventory => "success",
        WorkerRequest::Inspect { target, .. } => &target.name,
    };
    match mode {
        "authorized-fixture" => {
            use razer_hid_helper::{
                process::{current, ParentLease},
                session_guard::load,
                worker_session::authorize,
            };
            let context = envelope.session.unwrap();
            let parent = ParentLease::transferred(context.parent_handle).unwrap();
            let record = load(&context.guard_path).unwrap();
            let mode = authorize(
                &record,
                &context,
                &current().unwrap(),
                parent.identity(),
                parent.active().unwrap(),
                &request,
                args.iter().any(|arg| arg == "--allow-writes"),
                &razer_hid_helper::worker_session::WorkerAuthority {
                    expected_guard: &context.guard_path,
                    parent_image: &parent.image().unwrap(),
                    companion_image: &parent.image().unwrap(),
                },
            )
            .unwrap();
            let bytes = serde_json::to_vec(&WorkerResponse {
                result: Ok(json!({"authorized":true,"allowWrites":mode})),
            })
            .unwrap();
            write_frame(&mut io::stdout(), &bytes, OUTPUT_LIMIT).unwrap();
            return;
        }
        "hang" => loop {
            std::thread::sleep(Duration::from_secs(1));
        },
        "late-success" => std::thread::sleep(Duration::from_secs(10)),
        "crash" => std::process::exit(7),
        "excess-output" => {
            let _ = io::stdout().write_all(&((OUTPUT_LIMIT + 1) as u32).to_le_bytes());
            return;
        }
        "duplicate-result" => {
            write_frame(
                &mut io::stdout(),
                br#"{"result":{"Ok":{"nested":{"verified":true,"verified":false}}}}"#,
                OUTPUT_LIMIT,
            )
            .unwrap();
            return;
        }
        "partial-hang" => {
            let WorkerRequest::Inspect { target, .. } = &request else {
                unreachable!()
            };
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(target.reason.as_ref().unwrap())
                .unwrap();
            file.write_all(b"1").unwrap();
            file.sync_all().unwrap();
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        _ => {}
    }
    let requested = match &request {
        WorkerRequest::Inspect { allow_writes, .. } => *allow_writes,
        _ => false,
    };
    let bytes = serde_json::to_vec(&WorkerResponse {
        result: Ok(json!({"fixture":true,"requestedWrites":requested,"argv":args})),
    })
    .unwrap();
    write_frame(&mut io::stdout(), &bytes, OUTPUT_LIMIT).unwrap();
    if mode == "extra-frame" {
        io::stdout().write_all(b"extra").unwrap();
    }
}
