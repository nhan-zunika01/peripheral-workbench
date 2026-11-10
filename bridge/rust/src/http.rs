use crate::{coordinator::Coordinator, session_guard::valid_id, ApiError, Change, JsValue};
use http_body_util::{BodyExt, Full};
use hyper::{
    body::{Body, Bytes},
    header, Request, Response,
};
use serde_json::{json, Value};
use std::{convert::Infallible, sync::Arc, time::Duration};
use subtle::ConstantTimeEq;

pub type HttpResponse = Response<Full<Bytes>>;
pub struct HttpApp {
    origin: String,
    credential: String,
    token: String,
    port: u16,
    writes: bool,
    pub coordinator: Arc<Coordinator>,
}
impl HttpApp {
    pub fn new(
        origin: String,
        token: String,
        port: u16,
        writes: bool,
        coordinator: Arc<Coordinator>,
    ) -> Result<Self, String> {
        crate::cli::parse(&["--origin".into(), origin.clone()], None)?;
        if token.len() != 64
            || !token
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("Invalid pairing token".into());
        }
        Ok(Self {
            origin,
            credential: format!("Bearer {token}"),
            token,
            port,
            writes,
            coordinator,
        })
    }
    pub async fn handle<B>(&self, request: Request<B>) -> Result<HttpResponse, Infallible>
    where
        B: Body<Data = Bytes> + Unpin,
        B::Error: std::fmt::Display,
    {
        let headers = request.headers();
        let duplicate = ["host", "origin", "authorization", "content-type"]
            .iter()
            .any(|name| headers.get_all(*name).iter().count() > 1);
        let duplicate_trust = headers.get_all("host").iter().count() > 1
            || headers.get_all("origin").iter().count() > 1;
        let trusted = !duplicate_trust
            && headers.get("host").and_then(|v| v.to_str().ok())
                == Some(format!("127.0.0.1:{}", self.port).as_str())
            && headers.get("origin").and_then(|v| v.to_str().ok()) == Some(self.origin.as_str());
        let result = if duplicate_trust {
            Err(ApiError::new(400, "Duplicate header"))
        } else if !trusted {
            Err(ApiError::new(403, "Host or UI origin not allowed"))
        } else if duplicate {
            Err(ApiError::new(400, "Duplicate header"))
        } else {
            let started = request
                .extensions()
                .get::<crate::http_server::RequestStart>()
                .map(|start| start.0)
                .unwrap_or_else(tokio::time::Instant::now);
            let deadline = started + Duration::from_secs(80);
            if let Err(error) = check_deadline(deadline) {
                Err(error)
            } else {
                tokio::time::timeout_at(deadline, self.route(request, deadline))
                    .await
                    .unwrap_or_else(|_| Err(ApiError::new(408, "Request timed out")))
            }
        };
        let (status, body, preflight, pair) = match result {
            Ok(result) => result,
            Err(error) => {
                let mut body = json!({"error":error.public_message()});
                if !error.internal && error.code.as_deref() == Some("STATE_CONFLICT") {
                    body["code"] = "STATE_CONFLICT".into();
                    body["actualValue"] = error.actual_value.unwrap_or(Value::Null)
                }
                (
                    if error.internal { 502 } else { error.status },
                    body,
                    false,
                    false,
                )
            }
        };
        let bytes = if status == 204 {
            Vec::new()
        } else {
            serde_json::to_vec(&JsValue::from(body).to_wire_value()).unwrap()
        };
        let mut response = Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::CACHE_CONTROL, "no-store")
            .header("x-content-type-options", "nosniff");
        if trusted {
            response = response
                .header("access-control-allow-origin", &self.origin)
                .header(header::VARY, "Origin")
        }
        if preflight {
            response = response
                .header("access-control-allow-methods", "GET, POST")
                .header(
                    "access-control-allow-headers",
                    "Authorization, Content-Type",
                )
        }
        if pair {
            response = response.header("x-razer-companion-backend", "rust").header(
                "x-razer-companion-writes",
                if self.writes { "1" } else { "0" },
            )
        }
        Ok(response.body(Full::new(Bytes::from(bytes))).unwrap())
    }
    async fn route<B>(
        &self,
        mut request: Request<B>,
        deadline: tokio::time::Instant,
    ) -> Result<(u16, Value, bool, bool), ApiError>
    where
        B: Body<Data = Bytes> + Unpin,
        B::Error: std::fmt::Display,
    {
        let text = |name: &str| {
            request
                .headers()
                .get_all(name)
                .iter()
                .map(|v| v.to_str().unwrap_or(""))
                .collect::<Vec<_>>()
                .join(", ")
        };
        if request.method() == "OPTIONS" {
            if !["GET", "POST"].contains(&text("access-control-request-method").as_str()) {
                return Err(ApiError::new(405, "Method not allowed"));
            }
            if text("access-control-request-headers")
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .any(|s| {
                    !s.eq_ignore_ascii_case("authorization")
                        && !s.eq_ignore_ascii_case("content-type")
                })
            {
                return Err(ApiError::new(403, "Header not allowed"));
            }
            return Ok((204, Value::Null, true, false));
        }
        let raw = request.uri().to_string();
        if request.method() == "GET" && raw == "/api/pair" {
            return Ok((200, json!({"token":self.token}), false, true));
        }
        if text("authorization")
            .as_bytes()
            .ct_eq(self.credential.as_bytes())
            .unwrap_u8()
            != 1
        {
            return Err(ApiError::new(401, "Incorrect pairing token"));
        }
        let route = url::Url::parse("http://127.0.0.1")
            .unwrap()
            .join(&raw)
            .map_err(|_| ApiError::new(404, "Route not found"))?;
        if request.method() == "GET" && route.path() == "/api/state" {
            let id = route
                .query_pairs()
                .find(|(key, _)| key == "deviceId")
                .map(|(_, value)| value.into_owned())
                .filter(|id| !id.is_empty());
            if id.as_ref().is_some_and(|id| !valid_id(id)) {
                return Err(ApiError::new(400, "Invalid device identity"));
            }
            check_deadline(deadline)?;
            return Ok((
                200,
                self.coordinator.read(id)?.result().await?,
                false,
                false,
            ));
        }
        if request.method() != "POST" || raw != "/api/settings" {
            return Err(ApiError::new(404, "Route not found"));
        }
        if text("content-type") != "application/json" {
            return Err(ApiError::new(415, "Expected application/json"));
        }
        let mut bytes = Vec::new();
        loop {
            let frame = request.body_mut().frame().await;
            check_deadline(deadline)?;
            let Some(frame) = frame else { break };
            let frame = frame.map_err(|_| ApiError::new(400, "Invalid request body"))?;
            if let Ok(data) = frame.into_data() {
                if bytes.len() + data.len() > 16384 {
                    return Err(ApiError::new(413, "Request too large"));
                }
                bytes.extend_from_slice(&data);
            }
        }
        let change = Change::parse(&bytes);
        check_deadline(deadline)?;
        let change = change?;
        Ok((
            200,
            self.coordinator.write(change)?.result().await?,
            false,
            false,
        ))
    }
}
fn check_deadline(deadline: tokio::time::Instant) -> Result<(), ApiError> {
    if tokio::time::Instant::now() >= deadline {
        Err(ApiError::new(408, "Request timed out"))
    } else {
        Ok(())
    }
}

pub fn new_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 32];
    #[cfg(windows)]
    {
        use windows_sys::Win32::Security::Cryptography::{
            BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        };
        if unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        } < 0
        {
            return Err(std::io::Error::other("OS random source failed"));
        }
    }
    #[cfg(not(windows))]
    {
        use std::io::Read;
        std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
