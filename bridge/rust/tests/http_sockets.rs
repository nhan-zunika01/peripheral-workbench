use razer_hid_helper::{
    backend::Backend, coordinator::Coordinator, http::HttpApp, http_server, ApiError, Change,
};
use serde_json::{json, Value};
use std::sync::{Arc, Condvar, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{watch, Notify},
    time::{advance, Duration},
};
#[derive(Default)]
struct Gate {
    released: Mutex<bool>,
    cv: Condvar,
    entered: Notify,
}
impl Gate {
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.cv.notify_all();
    }
}
struct Release(Arc<Gate>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.release()
    }
}
struct Fake(Option<Arc<Gate>>);
impl Backend for Fake {
    fn snapshot(&mut self, id: Option<&str>) -> Result<Value, ApiError> {
        Ok(
            json!({"selectedDeviceId":id.unwrap_or("bbbbbbbbbbbbbbbbbbbbbbbb"),"connected":true,"settings":[{"id":"dpi","type":"number","min":100,"max":35000,"writable":true,"value":800}]}),
        )
    }
    fn apply(&mut self, _: &Change) -> Result<Value, ApiError> {
        if let Some(gate) = &self.0 {
            gate.entered.notify_one();
            let mut released = gate.released.lock().unwrap();
            while !*released {
                released = gate.cv.wait(released).unwrap();
            }
        }
        Ok(json!({"verified":true,"verification":"hardware-readback"}))
    }
}
async fn socket_pair() -> (TcpStream, TcpStream, u16) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let (server, _) = listener.accept().await.unwrap();
    (client, server, port)
}
fn app(port: u16, gate: Option<Arc<Gate>>) -> Arc<HttpApp> {
    Arc::new(
        HttpApp::new(
            "https://mouse.example".into(),
            "a".repeat(64),
            port,
            true,
            Arc::new(Coordinator::start(move || Ok(Box::new(Fake(gate)))).unwrap()),
        )
        .unwrap(),
    )
}
fn post(port: u16) -> String {
    let body = format!(
        r#"{{"deviceId":"{}","id":"dpi","value":1600}}"#,
        "b".repeat(24)
    );
    format!("POST /api/settings HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://mouse.example\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}","a".repeat(64),body.len())
}
async fn settle() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}
#[tokio::test(start_paused = true)]
async fn hyper_closes_incomplete_headers_at_ten_seconds() {
    let (mut client, server, port) = socket_pair().await;
    let app = app(port, None);
    let (_stop, rx) = watch::channel(false);
    let task = tokio::spawn(async move {
        http_server::connection(
            server,
            move |request| {
                let app = app.clone();
                async move { app.handle(request).await }
            },
            rx,
        )
        .await
    });
    client
        .write_all(b"GET /api/pair HTTP/1.1\r\nHost:")
        .await
        .unwrap();
    settle().await;
    advance(Duration::from_secs(9)).await;
    assert!(!task.is_finished());
    advance(Duration::from_secs(1)).await;
    settle().await;
    let mut bytes = [0; 512];
    let count = client.read(&mut bytes).await.unwrap();
    assert!(count == 0 || String::from_utf8_lossy(&bytes[..count]).starts_with("HTTP/1.1 408"));
    task.await.unwrap();
}
#[tokio::test(start_paused = true)]
async fn socket_idle_clock_resets_on_progress_and_allows_long_connections() {
    let (mut client, server, _) = socket_pair().await;
    let mut server = http_server::ProgressIo::new(server);
    let mut byte = [0; 1];
    for expected in [1u8, 2] {
        advance(Duration::from_secs(84)).await;
        client.write_all(&[expected]).await.unwrap();
        server.read_exact(&mut byte).await.unwrap();
        assert_eq!(byte, [expected]);
    }
    advance(Duration::from_secs(86)).await;
    assert_eq!(
        server.read(&mut byte).await.unwrap_err().kind(),
        std::io::ErrorKind::TimedOut
    );
}
#[tokio::test]
async fn disconnected_http_client_does_not_release_an_apply_lease() {
    let gate = Arc::new(Gate::default());
    let release = Release(gate.clone());
    let (mut client, server, port) = socket_pair().await;
    let app = app(port, Some(gate.clone()));
    let owned = app.clone();
    let (_stop, rx) = watch::channel(false);
    let task = tokio::spawn(async move {
        http_server::connection(
            server,
            move |request| {
                let app = owned.clone();
                async move { app.handle(request).await }
            },
            rx,
        )
        .await
    });
    client.write_all(post(port).as_bytes()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), gate.entered.notified())
        .await
        .unwrap();
    drop(client);
    let request = hyper::Request::builder()
        .method("POST")
        .uri("/api/settings")
        .header("host", format!("127.0.0.1:{port}"))
        .header("origin", "https://mouse.example")
        .header("authorization", format!("Bearer {}", "a".repeat(64)))
        .header("content-type", "application/json")
        .body(http_body_util::Full::new(hyper::body::Bytes::from(
            format!(
                r#"{{"deviceId":"{}","id":"dpi","value":1800}}"#,
                "b".repeat(24)
            ),
        )))
        .unwrap();
    assert_eq!(app.handle(request).await.unwrap().status(), 409);
    drop(release);
    task.await.unwrap();
    app.coordinator.shutdown().unwrap();
}
#[tokio::test]
async fn graceful_stop_rejects_new_dispatch_and_waits_for_owned_apply() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let gate = Arc::new(Gate::default());
    let release = Release(gate.clone());
    let app = app(port, Some(gate.clone()));
    let owned = app.clone();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        http_server::serve(listener, owned, async {
            let _ = stop_rx.await;
        })
        .await
    });
    let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    client.write_all(post(port).as_bytes()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), gate.entered.notified())
        .await
        .unwrap();
    stop_tx.send(()).unwrap();
    settle().await;
    assert!(!task.is_finished(), "stop must drain the owned apply");
    assert_eq!(app.coordinator.read(None).unwrap_err().status, 503);
    drop(release);
    let mut bytes = Vec::new();
    client.read_to_end(&mut bytes).await.unwrap();
    assert!(String::from_utf8_lossy(&bytes).starts_with("HTTP/1.1 200"));
    task.await.unwrap().unwrap();
}
