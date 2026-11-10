mod contract_backend;
mod contract_observations;
use contract_backend::{FakeBackend, Shared, State};
use razer_hid_helper::{
    coordinator::Coordinator,
    http::{new_token, HttpApp},
    http_server::connection,
};
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    sync::{Arc, Condvar, Mutex, RwLock},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{mpsc, watch},
    task::JoinSet,
};
fn emit(value: Value) {
    println!("{value}");
    std::io::stdout().flush().unwrap()
}
fn app(state: Shared, port: u16, origin: String, token: String, writes: bool) -> Arc<HttpApp> {
    Arc::new(
        HttpApp::new(
            origin,
            token,
            port,
            writes,
            Arc::new(Coordinator::start(move || Ok(Box::new(FakeBackend(state)))).unwrap()),
        )
        .unwrap(),
    )
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    if std::env::args().skip(1).collect::<Vec<_>>() != ["--serve-contract-fixture"] {
        assert_eq!(new_token().unwrap().len(), 64);
        return;
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let state: Shared = Arc::new((Mutex::new(State::default()), Condvar::new()));
    let origin = "https://mouse.example".to_owned();
    let token = "a".repeat(64);
    let current = Arc::new(RwLock::new(app(
        state.clone(),
        port,
        origin.clone(),
        token.clone(),
        true,
    )));
    let (tx, mut commands) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                break;
            };
            if tx.send(value).is_err() {
                break;
            }
        }
    });
    let (stop, rx) = watch::channel(false);
    let accepting = {
        let current = current.clone();
        let state = state.clone();
        let mut halted = rx.clone();
        tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    _=halted.changed()=>break,
                    accepted=listener.accept()=> {
                        let (stream,_)=accepted.unwrap();let shared=current.clone();let state=state.clone();let rx=rx.clone();
                        tasks.spawn(async move {connection(stream,move |request| {
                            let app=shared.read().unwrap().clone();state.0.lock().unwrap().requests+=1;
                            async move {app.handle(request).await}
                        },rx).await;});
                    },
                }
            }
            while tasks.join_next().await.is_some() {}
        })
    };
    emit(json!({"ready":true,"protocol":1,"port":port}));
    while let Some(command) = commands.recv().await {
        let op = command["op"].as_str().unwrap_or("");
        let mut output = Value::Null;
        match op {
            "reset" => {
                let writes = command["fakeMode"] != "read-only";
                *state.0.lock().unwrap() = State {
                    config: command["backend"].clone(),
                    setting: command["backend"]
                        .get("setting")
                        .cloned()
                        .unwrap_or_else(contract_backend::basic),
                    hold: command["hold"].as_str().unwrap_or("").into(),
                    shared: command["hold"] == "first-snapshot",
                    writes,
                    ..Default::default()
                };
                let old = std::mem::replace(
                    &mut *current.write().unwrap(),
                    app(
                        state.clone(),
                        port,
                        command["origin"].as_str().unwrap().into(),
                        command["token"].as_str().unwrap().into(),
                        writes,
                    ),
                );
                old.coordinator.shutdown().unwrap();
            }
            "set-token" => {
                let old = current.read().unwrap().clone();
                let next = Arc::new(
                    HttpApp::new(
                        origin.clone(),
                        command["token"].as_str().unwrap().into(),
                        port,
                        state.0.lock().unwrap().writes,
                        old.coordinator.clone(),
                    )
                    .unwrap(),
                );
                *current.write().unwrap() = next;
            }
            "observe" => output = json!({"transcript":state.0.lock().unwrap().log}),
            "checkpoint" | "barrier" => loop {
                let ready = {
                    let s = state.0.lock().unwrap();
                    if op == "barrier" {
                        s.requests >= command["requests"].as_u64().unwrap() as usize
                    } else {
                        s.log
                            .iter()
                            .filter(|v| v["action"] == command["action"])
                            .count()
                            >= command["count"].as_u64().unwrap() as usize
                    }
                };
                if ready {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            },
            "release" => {
                state.0.lock().unwrap().released = true;
                state.1.notify_all();
            }
            "advance" => {
                tokio::time::pause();
                tokio::time::advance(Duration::from_millis(
                    command["milliseconds"].as_u64().unwrap(),
                ))
                .await;
                tokio::time::resume();
            }
            "adapter" => output = contract_observations::adapter(&command["input"]),
            "inventory" => output = contract_observations::inventory(&command["input"]),
            "shutdown" => {
                state.0.lock().unwrap().released = true;
                state.1.notify_all();
                let _ = stop.send(true);
                accepting.await.unwrap();
                current.read().unwrap().coordinator.shutdown().unwrap();
                emit(json!({"id":command["id"],"ok":true,"result":null}));
                break;
            }
            _ => panic!("Unknown fixture command"),
        }
        emit(json!({"id":command["id"],"ok":true,"result":output}));
    }
}
