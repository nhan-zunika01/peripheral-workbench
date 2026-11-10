use http_body_util::{BodyExt, Full};
use hyper::{body::Bytes, Request};
use razer_hid_helper::{
    backend::Backend, coordinator::Coordinator, http::HttpApp, ApiError, Change,
};
use serde_json::{json, Value};
use std::sync::Arc;
#[test]
fn pairing_tokens_are_fresh_os_random_lowercase_hex() {
    let first = razer_hid_helper::http::new_token().unwrap();
    let second = razer_hid_helper::http::new_token().unwrap();
    assert_ne!(first, second);
    for token in [first, second] {
        assert_eq!(token.len(), 64);
        assert!(token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }
}
struct Fake;
impl Backend for Fake {
    fn snapshot(&mut self, _: Option<&str>) -> Result<Value, ApiError> {
        Ok(json!({"connected":false,"settings":[]}))
    }
    fn apply(&mut self, _: &Change) -> Result<Value, ApiError> {
        panic!("boundary rejected request reached apply")
    }
}
#[tokio::test]
async fn trust_boundary_rejects_before_backend_and_pair_returns_marker() {
    let app = HttpApp::new(
        "https://mouse.example".into(),
        "a".repeat(64),
        12345,
        false,
        Arc::new(Coordinator::start(|| Ok(Box::new(Fake))).unwrap()),
    )
    .unwrap();
    let response = app
        .handle(
            Request::builder()
                .uri("/api/pair")
                .body(Full::new(Bytes::new()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    assert!(response
        .headers()
        .get("access-control-allow-origin")
        .is_none());
    let response = app
        .handle(
            Request::builder()
                .uri("/api/pair")
                .header("host", "127.0.0.1:12345")
                .header("origin", "https://mouse.example")
                .body(Full::new(Bytes::new()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["x-razer-companion-writes"], "0");
    let value: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(value["token"], "a".repeat(64));
}
#[tokio::test]
async fn state_uses_url_pathname_for_absolute_form_requests_like_legacy() {
    let app = HttpApp::new(
        "https://mouse.example".into(),
        "a".repeat(64),
        12345,
        false,
        Arc::new(Coordinator::start(|| Ok(Box::new(Fake))).unwrap()),
    )
    .unwrap();
    let request = Request::builder()
        .uri("http://127.0.0.1:12345/api/state?deviceId=")
        .header("host", "127.0.0.1:12345")
        .header("origin", "https://mouse.example")
        .header("authorization", format!("Bearer {}", "a".repeat(64)))
        .body(Full::new(Bytes::new()))
        .unwrap();
    let response = app.handle(request).await.unwrap();
    assert_eq!(
        response.status(),
        200,
        "GET state is matched by URL pathname after Host/Origin/auth checks"
    );
}
#[tokio::test(start_paused = true)]
async fn request_budget_includes_time_spent_receiving_headers() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::watch,
        time::{advance, Duration},
    };
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let (server, _) = listener.accept().await.unwrap();
    let app = Arc::new(
        HttpApp::new(
            "https://mouse.example".into(),
            "a".repeat(64),
            port,
            false,
            Arc::new(Coordinator::start(|| Ok(Box::new(Fake))).unwrap()),
        )
        .unwrap(),
    );
    let (_stop, rx) = watch::channel(false);
    let task = tokio::spawn(async move {
        razer_hid_helper::http_server::connection(
            server,
            move |request| {
                let app = app.clone();
                async move { app.handle(request).await }
            },
            rx,
        )
        .await;
    });
    client
        .write_all(b"POST /api/settings HTTP/1.1\r\n")
        .await
        .unwrap();
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    advance(Duration::from_secs(9)).await;
    client.write_all(format!("Host: 127.0.0.1:{port}\r\nOrigin: https://mouse.example\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: 1\r\n\r\n","a".repeat(64)).as_bytes()).await.unwrap();
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    advance(Duration::from_secs(71)).await;
    let mut bytes = [0; 512];
    let read = tokio::time::timeout(Duration::from_secs(1), client.read(&mut bytes)).await;
    task.abort();
    assert!(
        read.is_ok(),
        "request must expire80s after first header byte, including9s spent on headers"
    );
    let count = read.unwrap().unwrap();
    assert!(String::from_utf8_lossy(&bytes[..count]).starts_with("HTTP/1.1 408"));
}
#[test]
fn recovery_automatic_shutdown_cannot_record_operator_observation() {
    use razer_hid_helper::recovery_http::RecoveryBackend;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let finished = Arc::new(AtomicUsize::new(0));
    let receipt = finished.clone();
    let mut recovery = RecoveryBackend::new(
        Fake,
        "b".repeat(24),
        move |_, _| {
            receipt.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        |_: &Value| Ok(()),
    );
    assert!(
        recovery.shutdown().is_err(),
        "automatic owner shutdown is not an operator acknowledgment"
    );
    assert_eq!(
        finished.load(Ordering::SeqCst),
        0,
        "guard finisher must remain untouched on startup or HTTP failure"
    );
}
#[test]
fn recovery_pins_reads_rejects_other_device_and_finishes_only_once() {
    use razer_hid_helper::recovery_http::RecoveryBackend;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Seen(Arc<AtomicUsize>);
    impl Backend for Seen {
        fn snapshot(&mut self, id: Option<&str>) -> Result<Value, ApiError> {
            assert_eq!(id, Some("bbbbbbbbbbbbbbbbbbbbbbbb"));
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"connected":true,"selectedDeviceId":id,"settings":[]}))
        }
        fn apply(&mut self, _: &Change) -> Result<Value, ApiError> {
            panic!("recovery must reject apply before backend dispatch")
        }
    }
    let reads = Arc::new(AtomicUsize::new(0));
    let finishes = Arc::new(AtomicUsize::new(0));
    let receipt = finishes.clone();
    let mut recovery = RecoveryBackend::new(
        Seen(reads.clone()),
        "b".repeat(24),
        move |_, outcome: Value| {
            assert_eq!(outcome["observedDeviceId"], "b".repeat(24));
            receipt.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        |_: &Value| Ok(()),
    );
    assert_eq!(
        recovery.snapshot(Some(&"c".repeat(24))).unwrap_err().status,
        409
    );
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    assert_eq!(
        recovery
            .apply(
                &Change::parse(
                    format!(
                        r#"{{"deviceId":"{}","id":"dpi","value":1600}}"#,
                        "b".repeat(24)
                    )
                    .as_bytes()
                )
                .unwrap()
            )
            .unwrap_err()
            .status,
        400
    );
    recovery.snapshot(None).unwrap();
    recovery.snapshot(Some(&"b".repeat(24))).unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    recovery.operator_stop().store(true, Ordering::SeqCst);
    recovery.shutdown().unwrap();
    recovery.shutdown().unwrap();
    assert_eq!(finishes.load(Ordering::SeqCst), 1);
}
#[test]
fn recovery_latest_failed_or_disconnected_read_invalidates_initial_observation() {
    use razer_hid_helper::recovery_http::RecoveryBackend;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Lost(bool);
    impl Backend for Lost {
        fn snapshot(&mut self, id: Option<&str>) -> Result<Value, ApiError> {
            assert_eq!(
                id,
                Some("bbbbbbbbbbbbbbbbbbbbbbbb"),
                "omitted reads stay pinned to affected A"
            );
            if self.0 {
                Err(ApiError::new(502, "Inspect failed"))
            } else {
                Ok(json!({"connected":false,"selectedDeviceId":id,"settings":[]}))
            }
        }
        fn apply(&mut self, _: &Change) -> Result<Value, ApiError> {
            panic!("readonly")
        }
    }
    for failed in [false, true] {
        let finished = Arc::new(AtomicUsize::new(0));
        let receipt = finished.clone();
        let mut recovery = RecoveryBackend::new(
            Lost(failed),
            "b".repeat(24),
            move |_, _| {
                receipt.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            |_: &Value| Ok(()),
        );
        let state = recovery.snapshot(None);
        assert_eq!(state.is_err(), failed);
        recovery.operator_stop().store(true, Ordering::SeqCst);
        assert!(recovery.shutdown().is_err(),"latest read failed/absent A must retain guard even after operator Ctrl+C; error={failed}");
        assert_eq!(finished.load(Ordering::SeqCst), 0);
    }
}
#[tokio::test]
async fn preflight_checks_every_repeated_requested_header_field() {
    let app = HttpApp::new(
        "https://mouse.example".into(),
        "a".repeat(64),
        12345,
        false,
        Arc::new(Coordinator::start(|| Ok(Box::new(Fake))).unwrap()),
    )
    .unwrap();
    let request = Request::builder()
        .method("OPTIONS")
        .uri("/anything")
        .header("host", "127.0.0.1:12345")
        .header("origin", "https://mouse.example")
        .header("access-control-request-method", "POST")
        .header("access-control-request-headers", "Authorization")
        .header("access-control-request-headers", "X-Secret")
        .body(Full::new(Bytes::new()))
        .unwrap();
    let response = app.handle(request).await.unwrap();
    assert_eq!(
        response.status(),
        403,
        "a second header list must not hide a forbidden requested header"
    );
}
#[tokio::test(start_paused = true)]
async fn buffered_pipeline_request_keeps_its_observed_network_start() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::watch,
        time::{advance, Duration},
    };
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let (server, _) = listener.accept().await.unwrap();
    let app = Arc::new(
        HttpApp::new(
            "https://mouse.example".into(),
            "a".repeat(64),
            port,
            false,
            Arc::new(Coordinator::start(|| Ok(Box::new(Fake))).unwrap()),
        )
        .unwrap(),
    );
    let (_stop, rx) = watch::channel(false);
    let task = tokio::spawn(async move {
        razer_hid_helper::http_server::connection(
            server,
            move |request| {
                let app = app.clone();
                async move {
                    if request.uri().path() == "/hold" {
                        tokio::time::sleep(Duration::from_secs(75)).await;
                    }
                    app.handle(request).await
                }
            },
            rx,
        )
        .await;
    });
    let headers = format!(
        "Host: 127.0.0.1:{port}\r\nOrigin: https://mouse.example\r\nAuthorization: Bearer {}\r\n",
        "a".repeat(64)
    );
    client.write_all(format!("GET /hold HTTP/1.1\r\n{headers}\r\nPOST /api/settings HTTP/1.1\r\n{headers}Content-Type: application/json\r\nContent-Length: 1\r\n\r\n").as_bytes()).await.unwrap();
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    advance(Duration::from_secs(75)).await;
    let mut bytes = [0; 1024];
    let count = client.read(&mut bytes).await.unwrap();
    assert!(String::from_utf8_lossy(&bytes[..count]).starts_with("HTTP/1.1 404"));
    advance(Duration::from_secs(5)).await;
    let response = tokio::time::timeout(Duration::from_secs(1), client.read(&mut bytes)).await;
    task.abort();
    assert!(
        response.is_ok(),
        "buffered second request arrived with first, so its80s budget cannot restart at75s"
    );
    let count = response.unwrap().unwrap();
    assert!(String::from_utf8_lossy(&bytes[..count]).starts_with("HTTP/1.1 408"));
}
