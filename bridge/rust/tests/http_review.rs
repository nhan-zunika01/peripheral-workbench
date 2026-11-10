use http_body_util::Full;
use hyper::{
    body::{Body, Bytes, Frame},
    Request,
};
use razer_hid_helper::{
    backend::Backend, coordinator::Coordinator, http::HttpApp, http_server::RequestStart, ApiError,
    Change,
};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    task::{Context, Poll},
};
use tokio::time::{Duration, Instant};
struct Count(Arc<AtomicUsize>);
impl Backend for Count {
    fn snapshot(&mut self, _: Option<&str>) -> Result<Value, ApiError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(
            json!({"connected":true,"selectedDeviceId":"b".repeat(24),"settings":[{"id":"dpi","type":"number","writable":true,"value":800}]}),
        )
    }
    fn apply(&mut self, _: &Change) -> Result<Value, ApiError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"verified":true}))
    }
}
fn app() -> (HttpApp, Arc<AtomicUsize>) {
    let count = Arc::new(AtomicUsize::new(0));
    let backend = Count(count.clone());
    (
        HttpApp::new(
            "https://mouse.example".into(),
            "a".repeat(64),
            12345,
            true,
            Arc::new(Coordinator::start(move || Ok(Box::new(backend))).unwrap()),
        )
        .unwrap(),
        count,
    )
}
fn request<B>(method: &str, body: B) -> Request<B> {
    Request::builder()
        .method(method)
        .uri(if method == "POST" {
            "/api/settings"
        } else {
            "/api/state"
        })
        .header("host", "127.0.0.1:12345")
        .header("origin", "https://mouse.example")
        .header("authorization", format!("Bearer {}", "a".repeat(64)))
        .header("content-type", "application/json")
        .body(body)
        .unwrap()
}
fn change() -> Bytes {
    Bytes::from(format!(
        r#"{{"deviceId":"{}","id":"dpi","value":1600}}"#,
        "b".repeat(24)
    ))
}
#[tokio::test(start_paused = true)]
async fn fully_buffered_expired_post_and_get_cannot_dispatch() {
    for method in ["POST", "GET"] {
        let (app, count) = app();
        let mut request = request(method, Full::new(change()));
        request
            .extensions_mut()
            .insert(RequestStart(Instant::now() - Duration::from_secs(80)));
        assert_eq!(
            app.handle(request).await.unwrap().status(),
            408,
            "expired {method} must not enter backend"
        );
        app.coordinator.shutdown().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }
}
struct ReadyAtDeadline {
    bytes: Option<Bytes>,
}
impl Body for ReadyAtDeadline {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        if let Some(bytes) = self.bytes.take() {
            std::thread::sleep(std::time::Duration::from_millis(20));
            Poll::Ready(Some(Ok(Frame::data(bytes))))
        } else {
            Poll::Ready(None)
        }
    }
}
#[tokio::test]
async fn body_ready_after_budget_cannot_enqueue_write() {
    let (app, count) = app();
    let mut request = request(
        "POST",
        ReadyAtDeadline {
            bytes: Some(change()),
        },
    );
    request.extensions_mut().insert(RequestStart(
        Instant::now() - Duration::from_secs(80) + Duration::from_millis(10),
    ));
    assert_eq!(app.handle(request).await.unwrap().status(), 408);
    app.coordinator.shutdown().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 0);
}
async fn late_body_must_timeout(bytes: Bytes) {
    let (app, count) = app();
    let mut request = request("POST", ReadyAtDeadline { bytes: Some(bytes) });
    request.extensions_mut().insert(RequestStart(
        Instant::now() - Duration::from_secs(80) + Duration::from_millis(10),
    ));
    assert_eq!(app.handle(request).await.unwrap().status(), 408);
    app.coordinator.shutdown().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn late_malformed_body_deadline_precedes_json_error() {
    late_body_must_timeout(Bytes::from_static(b"{")).await;
}
#[tokio::test]
async fn late_oversized_body_deadline_precedes_size_error() {
    late_body_must_timeout(Bytes::from(vec![b' '; 16385])).await;
}
#[tokio::test]
async fn late_invalid_utf8_deadline_precedes_json_error() {
    late_body_must_timeout(Bytes::from_static(b"\xff")).await;
}
struct EndReadyAtDeadline {
    bytes: Option<Bytes>,
}
impl Body for EndReadyAtDeadline {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        if let Some(bytes) = self.bytes.take() {
            Poll::Ready(Some(Ok(Frame::data(bytes))))
        } else {
            std::thread::sleep(std::time::Duration::from_millis(20));
            Poll::Ready(None)
        }
    }
}
#[tokio::test]
async fn late_end_of_body_deadline_precedes_json_error() {
    let (app, count) = app();
    let mut request = request(
        "POST",
        EndReadyAtDeadline {
            bytes: Some(Bytes::from_static(b"{")),
        },
    );
    request.extensions_mut().insert(RequestStart(
        Instant::now() - Duration::from_secs(80) + Duration::from_millis(10),
    ));
    assert_eq!(app.handle(request).await.unwrap().status(), 408);
    app.coordinator.shutdown().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn wrong_host_or_origin_precedes_unrelated_duplicate_headers() {
    for (name, value, duplicate) in [
        ("host", "evil.example", "content-type"),
        ("origin", "https://evil.example", "authorization"),
    ] {
        let (app, count) = app();
        let mut request = request("POST", Full::new(change()));
        request.headers_mut().insert(name, value.parse().unwrap());
        request
            .headers_mut()
            .append(duplicate, "wrong".parse().unwrap());
        let response = app.handle(request).await.unwrap();
        assert_eq!(response.status(), 403);
        assert!(response
            .headers()
            .get("access-control-allow-origin")
            .is_none());
        app.coordinator.shutdown().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn readiness_read_alone_never_qualifies_recovery_for_operator_stop() {
    use razer_hid_helper::recovery_http::RecoveryBackend;
    let count = Arc::new(AtomicUsize::new(0));
    let receipt = count.clone();
    let mut recovery = RecoveryBackend::new(
        Count(Arc::new(AtomicUsize::new(0))),
        "b".repeat(24),
        move |_, _| {
            receipt.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        |_: &Value| Ok(()),
    );
    recovery.operator_stop().store(true, Ordering::SeqCst);
    assert!(
        recovery.shutdown().is_err(),
        "unpublished readiness state must not clear the guard"
    );
    assert_eq!(count.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn unexpected_worker_spawn_error_is_generic_and_known_errors_are_preserved() {
    struct Failure(Option<ApiError>);
    impl Backend for Failure {
        fn snapshot(&mut self, _: Option<&str>) -> Result<Value, ApiError> {
            Err(self.0.take().unwrap())
        }
        fn apply(&mut self, _: &Change) -> Result<Value, ApiError> {
            unreachable!()
        }
    }
    let dir = std::env::temp_dir().join(format!(
        "razer-http-review-{}",
        razer_hid_helper::process::nonce().unwrap()
    ));
    std::fs::create_dir(&dir).unwrap();
    let mut guard =
        razer_hid_helper::session_guard::SessionGuard::create_at(dir.join("session.json")).unwrap();
    let private = razer_hid_helper::worker::WorkerRunner::new(
        dir.join("private-path-unavailable.exe"),
        false,
    )
    .run(
        &razer_hid_helper::worker::WorkerRequest::Inventory,
        &mut guard,
        || Ok(()),
    )
    .unwrap_err();
    guard.finish().unwrap();
    assert!(private.error.contains("Private worker failed"));
    for (error, expected) in [
        (
            private,
            "Native transport failed; reconnect and inspect the companion console.",
        ),
        (
            ApiError::new(502, "Native operation could not be verified"),
            "Native operation could not be verified",
        ),
    ] {
        let backend = Failure(Some(error));
        let app = HttpApp::new(
            "https://mouse.example".into(),
            "a".repeat(64),
            12345,
            false,
            Arc::new(Coordinator::start(move || Ok(Box::new(backend))).unwrap()),
        )
        .unwrap();
        let response = app
            .handle(request("GET", Full::new(Bytes::new())))
            .await
            .unwrap();
        assert_eq!(response.status(), 502);
        let bytes = http_body_util::BodyExt::collect(response.into_body())
            .await
            .unwrap()
            .to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body, json!({"error":expected}));
    }
}
#[test]
fn internal_errors_keep_private_classification_across_worker_json() {
    let error = ApiError::internal("OS detail from a private device path");
    let json = serde_json::to_value(&error).unwrap();
    assert_eq!(json["internal"], true);
    let decoded: ApiError = serde_json::from_value(json).unwrap();
    assert_eq!(decoded, error);
    assert_eq!(
        decoded.public_message(),
        "Native transport failed; reconnect and inspect the companion console."
    );
    assert!(serde_json::from_value::<ApiError>(
        json!({"status":502,"error":"x","internal":"false"})
    )
    .is_err());
    assert!(
        serde_json::from_value::<ApiError>(json!({"status":502,"error":"x","internal":null}))
            .is_err()
    );
    let public = ApiError::new(502, "Native operation could not be verified");
    let json = serde_json::to_value(&public).unwrap();
    assert!(json.get("internal").is_none());
    assert_eq!(serde_json::from_value::<ApiError>(json).unwrap(), public);
}
#[tokio::test]
async fn cancelled_recovery_read_publishes_full_console_state_before_eligibility() {
    use razer_hid_helper::recovery_http::RecoveryBackend;
    use std::sync::{Condvar, Mutex};
    type Gate = Arc<(Mutex<(bool, bool, usize)>, Condvar)>;
    struct Recover {
        gate: Gate,
    }
    impl Backend for Recover {
        fn snapshot(&mut self, id: Option<&str>) -> Result<Value, ApiError> {
            let (lock, cv) = &*self.gate;
            let mut s = lock.lock().unwrap();
            s.2 += 1;
            if s.2 == 2 {
                s.0 = true;
                cv.notify_all();
                while !s.1 {
                    s = cv.wait(s).unwrap();
                }
            }
            Ok(
                json!({"selectedDeviceId":id,"connected":s.2!=1,"settings":[{"id":"dpi","value":800,"writable":false}]}),
            )
        }
        fn apply(&mut self, _: &Change) -> Result<Value, ApiError> {
            unreachable!()
        }
    }
    for publication_fails in [false, true] {
        let gate = Arc::new((Mutex::new((false, false, 0)), Condvar::new()));
        let published = Arc::new(Mutex::new(Vec::<Value>::new()));
        let output = published.clone();
        let finishes = Arc::new(AtomicUsize::new(0));
        let receipt = finishes.clone();
        let backend = RecoveryBackend::new(
            Recover { gate: gate.clone() },
            "b".repeat(24),
            move |_, _| {
                receipt.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            move |state: &Value| {
                if publication_fails {
                    Err(ApiError::internal("Console flush failed"))
                } else {
                    output.lock().unwrap().push(state.clone());
                    Ok(())
                }
            },
        );
        let operator_stop = backend.operator_stop();
        let coordinator = Coordinator::start(move || Ok(Box::new(backend))).unwrap();
        assert_eq!(
            coordinator.read(None).unwrap().result().await.unwrap()["connected"],
            false
        );
        let pending = coordinator.read(None).unwrap();
        {
            let (lock, cv) = &*gate;
            let mut s = lock.lock().unwrap();
            while !s.0 {
                s = cv.wait(s).unwrap();
            }
        }
        let completion = coordinator.read(None).unwrap();
        drop(pending);
        {
            let (lock, cv) = &*gate;
            let mut s = lock.lock().unwrap();
            s.1 = true;
            cv.notify_all();
        }
        assert_eq!(completion.result().await.is_err(), publication_fails);
        operator_stop.store(true, Ordering::SeqCst);
        let drained = coordinator.shutdown();
        assert_eq!(drained.is_err(), publication_fails);
        assert_eq!(
            finishes.load(Ordering::SeqCst),
            usize::from(!publication_fails)
        );
        if publication_fails {
            assert!(published.lock().unwrap().is_empty());
        } else {
            assert_eq!(
                *published.lock().unwrap(),
                vec![
                    json!({"selectedDeviceId":"b".repeat(24),"connected":true,"settings":[{"id":"dpi","value":800,"writable":false}]})
                ]
            );
        }
    }
}
#[test]
fn stopping_before_publication_finishes_cannot_acknowledge_later_output() {
    use razer_hid_helper::recovery_http::RecoveryBackend;
    use std::sync::{atomic::AtomicBool, Mutex};
    let stop = Arc::new(Mutex::new(None::<Arc<AtomicBool>>));
    let signal = stop.clone();
    let finished = Arc::new(AtomicUsize::new(0));
    let receipt = finished.clone();
    let mut recovery = RecoveryBackend::new(
        Count(Arc::new(AtomicUsize::new(0))),
        "b".repeat(24),
        move |_, _| {
            receipt.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        move |_: &Value| {
            signal
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .store(true, Ordering::SeqCst);
            Ok(())
        },
    );
    *stop.lock().unwrap() = Some(recovery.operator_stop());
    recovery.snapshot(None).unwrap();
    assert!(
        recovery.shutdown().is_err(),
        "Ctrl+C before publication finishes must not acknowledge later console output"
    );
    assert_eq!(finished.load(Ordering::SeqCst), 0);
}
