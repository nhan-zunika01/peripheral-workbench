#![cfg(windows)]
use razer_hid_helper::{
    backend::Backend, coordinator::Coordinator, http::HttpApp, http_server,
    socket::ExclusiveSocket, ApiError, Change,
};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
struct NoDevice;
impl Backend for NoDevice {
    fn snapshot(&mut self, _: Option<&str>) -> Result<Value, ApiError> {
        panic!("pairing must not dispatch inventory or inspect")
    }
    fn apply(&mut self, _: &Change) -> Result<Value, ApiError> {
        panic!("pairing must not dispatch apply")
    }
}
struct OwnedChild {
    child: Child,
    output: Option<JoinHandle<()>>,
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let status = self.child.wait();
        if let Some(output) = self.output.take() {
            let _ = output.join();
        }
        eprintln!(
            "native fake fixture PID {} waited: {}",
            self.child.id(),
            status.is_ok()
        );
    }
}
#[test]
fn native_http_fixture_child() {
    if std::env::var("RAZER_NATIVE_HTTP_TEST_CHILD").as_deref() != Ok("1") {
        return;
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let socket = ExclusiveSocket::reserve(0).unwrap();
            let port = socket.port().unwrap();
            assert_ne!(port, 17321);
            let listener =
                tokio::net::TcpListener::from_std(socket.http_listener().unwrap()).unwrap();
            assert!(
                std::net::TcpListener::bind(("127.0.0.1", port)).is_err(),
                "native HTTP handoff must retain exclusive port ownership"
            );
            let app = Arc::new(
                HttpApp::new(
                    "https://mouse.example".into(),
                    "a".repeat(64),
                    port,
                    false,
                    Arc::new(Coordinator::start(|| Ok(Box::new(NoDevice))).unwrap()),
                )
                .unwrap(),
            );
            let (stop, stopped) = tokio::sync::oneshot::channel();
            let control = thread::spawn(move || {
                let mut line = String::new();
                let _ = std::io::stdin().read_line(&mut line);
                let _ = stop.send(());
            });
            println!("NATIVE_HTTP_READY:{port}");
            std::io::stdout().flush().unwrap();
            http_server::serve(listener, app, async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
            control.join().unwrap();
        });
}
#[test]
fn reserved_native_socket_serves_pairing_and_drains_in_bounded_child() {
    use std::os::windows::process::CommandExt;
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "native_http_fixture_child", "--nocapture"])
        .env("RAZER_NATIVE_HTTP_TEST_CHILD", "1")
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, lines) = mpsc::channel();
    let output = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut child = OwnedChild {
        child,
        output: Some(output),
    };
    let ready_deadline = Instant::now() + Duration::from_secs(5);
    let port = loop {
        let line = lines
            .recv_timeout(ready_deadline.saturating_duration_since(Instant::now()))
            .expect("native fake HTTP child did not publish readiness");
        if let Some(port) = line.strip_prefix("NATIVE_HTTP_READY:") {
            break port.parse::<u16>().unwrap();
        }
    };
    assert_ne!(port, 17321);
    let mut stream =
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(3)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream.write_all(format!("GET /api/pair HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://mouse.example\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
    let mut response = String::new();
    let read = stream.read_to_string(&mut response);
    assert!(
        read.is_ok(),
        "native exclusive socket must answer pairing within3s; error={read:?}; bytes={response:?}"
    );
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let (_, body) = response.split_once("\r\n\r\n").unwrap();
    let body: Value = serde_json::from_str(body).unwrap();
    assert_eq!(body["token"], "a".repeat(64));
    child
        .child
        .stdin
        .take()
        .unwrap()
        .write_all(b"stop\n")
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.child.try_wait().unwrap() {
            assert!(
                status.success(),
                "fake HTTP child shutdown failed: {status}"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "fake native HTTP child failed to drain"
        );
        thread::sleep(Duration::from_millis(10));
    }
}
