use razer_hid_helper::cli::parse;
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).into()).collect()
}
#[test]
fn exact_origin_options_and_recovery_read_only_override_are_checked() {
    assert!(!parse(&args(&[]), None).unwrap().allow_writes);
    for values in [
        vec!["--allow-writes", "--read-only"],
        vec!["--read-only", "--allow-writes"],
        vec!["--allow-writes", "--recover-read-only"],
    ] {
        assert!(!parse(&args(&values), None).unwrap().allow_writes);
    }
    for origin in [
        "http://localhost/",
        "https://user@example.com",
        "https://example.com/path",
        "file:///a",
        "https://example.com?x=1",
    ] {
        assert!(
            parse(&args(&["--origin", origin]), None).is_err(),
            "{origin}"
        );
    }
    for values in [
        vec!["--serve-contract-fixture"],
        vec!["--fixture", "fake.json"],
        vec!["--fake-mode", "approved-write"],
        vec!["--token", "secret"],
        vec!["--allow-writes", "--allow-writes"],
        vec!["--acknowledge-unresolved"],
        vec!["--device-id", "bad"],
        vec!["--internal-worker", "--origin", "http://a"],
    ] {
        assert!(parse(&args(&values), None).is_err());
    }
    assert_eq!(
        parse(&args(&[]), Some("https://example.com"))
            .unwrap()
            .origin,
        "https://example.com"
    );
}
#[test]
fn legacy_inspector_environment_fails_before_guard_or_hardware() {
    assert!(razer_hid_helper::cli::validate_environment(Some("http://127.0.0.1:9222")).is_err());
    assert!(razer_hid_helper::cli::validate_environment(Some("")).is_err());
    assert!(razer_hid_helper::cli::validate_environment(None).is_ok());
}

#[test]
fn explicit_write_request_is_preserved_by_parsing_but_rejected_by_production() {
    use std::process::{Command, Stdio};
    assert!(
        parse(&args(&["--allow-writes"]), None)
            .unwrap()
            .allow_writes
    );
    for mode in [
        vec!["--allow-writes"],
        vec!["--allow-writes", "--internal-worker"],
    ] {
        // The inspector blocker keeps the unfixed binary from reaching any session or HID.
        let output = Command::new(env!("CARGO_BIN_EXE_razer-companion"))
            .args(mode)
            .env("SYNAPSE_INSPECTOR_URL", "http://127.0.0.1:9222")
            .env_remove("UI_ORIGIN")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(!output.status.success());
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(
            error.contains("no verified model/firmware/setting evidence"),
            "{error}"
        );
        assert!(output.stdout.is_empty());
    }
    for mode in [
        vec!["--allow-writes", "--read-only"],
        vec!["--read-only", "--allow-writes"],
        vec!["--allow-writes", "--recover-read-only"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_razer-companion"))
            .args(mode)
            .env("SYNAPSE_INSPECTOR_URL", "http://127.0.0.1:9222")
            .env_remove("UI_ORIGIN")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(!output.status.success());
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(
            error.contains("SYNAPSE_INSPECTOR_URL is incompatible"),
            "{error}"
        );
    }
}

#[test]
fn raw_helper_rejects_unverified_writes_before_reading_requests() {
    use std::process::{Command, Stdio};
    // EOF exercises startup without sending a request that could enumerate HID on the unfixed binary.
    let output = Command::new(env!("CARGO_BIN_EXE_razer-hid-helper"))
        .arg("--allow-writes")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "the raw HID helper accepted an unverified write mode"
    );
    let error = String::from_utf8(output.stderr).unwrap();
    assert!(
        error.contains("no verified model/firmware/setting evidence"),
        "{error}"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn managed_shutdown_is_a_private_normal_server_mode_only() {
    assert!(parse(&args(&["--managed-shutdown", "--read-only"]), None).is_ok());
    for values in [
        vec!["--managed-shutdown", "--internal-worker"],
        vec!["--managed-shutdown", "--recover-read-only"],
        vec!["--managed-shutdown", "--managed-shutdown"],
    ] {
        assert!(parse(&args(&values), None).is_err());
    }
}

#[tokio::test]
async fn private_pipe_accepts_first_exact_frame_or_eof_and_bounds_malformed_input() {
    use razer_hid_helper::cli::managed_shutdown;
    for bytes in [b"".as_slice(), b"shutdown\n", b"shutdown\nextra"] {
        assert!(managed_shutdown(std::io::Cursor::new(bytes.to_vec()))
            .await
            .is_ok());
    }
    for bytes in [
        b"stop\n".as_slice(),
        b"shutdown",
        b"shutdownextra\n",
        &[b'x'; 100_000],
    ] {
        assert_eq!(
            managed_shutdown(std::io::Cursor::new(bytes.to_vec()))
                .await
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );
    }
}

#[test]
fn direct_signal_cancellation_does_not_wait_for_a_blocked_pipe_reader() {
    use std::{io::Read, sync::mpsc, time::Duration};
    struct Blocked(mpsc::Receiver<()>);
    impl Read for Blocked {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            let _ = self.0.recv();
            Ok(0)
        }
    }
    let (release, reader) = mpsc::channel();
    let (finished, runtime_done) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            tokio::select! {
                _=razer_hid_helper::cli::managed_shutdown(Blocked(reader))=>panic!("pipe is still open"),
                _=tokio::time::sleep(Duration::from_millis(10))=>{},
            }
        });
        drop(runtime);
        finished.send(()).unwrap();
    });
    let result = runtime_done.recv_timeout(Duration::from_secs(2));
    drop(release);
    thread.join().unwrap();
    assert!(
        result.is_ok(),
        "direct signal must not wait for inherited stdin EOF"
    );
}

#[cfg(windows)]
mod managed_process {
    use razer_hid_helper::{
        backend::Backend, coordinator::Coordinator, http::HttpApp, ApiError, Change,
    };
    use serde_json::{json, Value};
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpStream,
        process::{Child, Command, Stdio},
        sync::{mpsc, Arc},
        thread,
        time::{Duration, Instant},
    };
    struct FakeBackend;
    impl Backend for FakeBackend {
        fn snapshot(&mut self, _: Option<&str>) -> Result<Value, ApiError> {
            println!("MANAGED_WORK");
            std::io::stdout().flush().unwrap();
            thread::sleep(Duration::from_millis(100));
            Ok(
                json!({"connected":false,"devices":[],"settings":[],"message":"MOCK managed shutdown"}),
            )
        }
        fn apply(&mut self, _: &Change) -> Result<Value, ApiError> {
            panic!("no hardware writes")
        }
        fn shutdown(&mut self) -> Result<(), ApiError> {
            println!("MANAGED_DRAINED");
            Ok(())
        }
    }
    struct Owned(Child);
    impl Drop for Owned {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    fn line(receiver: &mpsc::Receiver<String>, prefix: &str) -> String {
        loop {
            let value = receiver
                .recv_timeout(Duration::from_secs(5))
                .expect("bounded fake-child checkpoint");
            if value.starts_with(prefix) {
                return value;
            }
        }
    }
    #[test]
    fn fake_managed_http_child() {
        if std::env::var("RAZER_MANAGED_HTTP_TEST_CHILD").as_deref() != Ok("1") {
            return;
        }
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                    .await
                    .unwrap();
                let port = listener.local_addr().unwrap().port();
                assert_ne!(port, 17321);
                let coordinator =
                    Arc::new(Coordinator::start(|| Ok(Box::new(FakeBackend))).unwrap());
                let app = Arc::new(
                    HttpApp::new(
                        "https://mouse.example".into(),
                        "a".repeat(64),
                        port,
                        false,
                        coordinator,
                    )
                    .unwrap(),
                );
                println!("MANAGED_READY:{port}");
                std::io::stdout().flush().unwrap();
                let mut stopped = Ok(());
                razer_hid_helper::http_server::serve(listener, app, async {
                    stopped = razer_hid_helper::cli::managed_shutdown(std::io::stdin()).await;
                })
                .await
                .unwrap();
                println!("MANAGED_FRAME_OK:{}", stopped.is_ok());
            });
    }
    #[test]
    fn inherited_pipe_frame_eof_and_malformed_input_drain_fake_http_before_exit() {
        for (frame, keep_open) in [
            (b"shutdown\n".as_slice(), true),
            (b"shutdown\n".as_slice(), false),
            (b"".as_slice(), false),
            (b"wrong\n".as_slice(), false),
            (b"shutdown\nextra".as_slice(), false),
            (b"shutdownextra\n".as_slice(), false),
        ] {
            let child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "managed_process::fake_managed_http_child",
                    "--nocapture",
                ])
                .env("RAZER_MANAGED_HTTP_TEST_CHILD", "1")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let mut owned = Owned(child);
            let stdout = owned.0.stdout.take().unwrap();
            let (sender, receiver) = mpsc::channel();
            let output = thread::spawn(move || {
                for value in BufReader::new(stdout).lines() {
                    if sender.send(value.unwrap()).is_err() {
                        break;
                    }
                }
            });
            let ready = line(&receiver, "MANAGED_READY:");
            let port: u16 = ready.split(':').nth(1).unwrap().parse().unwrap();
            assert_ne!(port, 17321);
            let mut socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            write!(socket,"GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://mouse.example\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n","a".repeat(64)).unwrap();
            line(&receiver, "MANAGED_WORK");
            let mut pipe = Some(owned.0.stdin.take().unwrap());
            pipe.as_mut().unwrap().write_all(frame).unwrap();
            pipe.as_mut().unwrap().flush().unwrap();
            if !keep_open {
                drop(pipe.take());
            }
            let mut response = String::new();
            socket.read_to_string(&mut response).unwrap();
            assert!(response.starts_with("HTTP/1.1 200"));
            assert!(response.contains("MOCK managed shutdown"));
            if keep_open {
                let deadline = Instant::now() + Duration::from_secs(2);
                loop {
                    if let Some(status) = owned.0.try_wait().unwrap() {
                        assert!(status.success());
                        break;
                    }
                    assert!(
                        Instant::now() < deadline,
                        "complete private shutdown frame must drain and exit before stdin EOF"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
            }
            line(&receiver, "MANAGED_DRAINED");
            assert_eq!(
                line(&receiver, "MANAGED_FRAME_OK:"),
                format!(
                    "MANAGED_FRAME_OK:{}",
                    frame.is_empty() || frame.starts_with(b"shutdown\n")
                )
            );
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Some(status) = owned.0.try_wait().unwrap() {
                    assert!(status.success());
                    break;
                }
                assert!(Instant::now() < deadline, "fake child did not exit");
                thread::sleep(Duration::from_millis(5));
            }
            output.join().unwrap();
        }
    }
}
