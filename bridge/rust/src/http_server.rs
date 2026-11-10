use crate::http::{HttpApp, HttpResponse};
use hyper::{body::Incoming, server::conn::http1, service::service_fn, Request};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{
    convert::Infallible,
    future::Future,
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::watch,
    task::JoinSet,
    time::{Instant, Sleep},
};

// Idle is measured from socket progress, including header and response bytes.
#[derive(Clone, Copy)]
pub struct RequestStart(pub Instant);
#[derive(Default)]
struct RequestClock {
    started: Option<Instant>,
    last_read: Option<Instant>,
    handling: bool,
}
pub struct ProgressIo<T> {
    inner: T,
    idle: Pin<Box<Sleep>>,
    clock: Arc<Mutex<RequestClock>>,
}
impl<T> ProgressIo<T> {
    pub fn new(inner: T) -> Self {
        Self {
            inner,
            idle: Box::pin(tokio::time::sleep(Duration::from_secs(85))),
            clock: Arc::new(Mutex::new(RequestClock::default())),
        }
    }
    fn progress(&mut self) {
        self.idle
            .as_mut()
            .reset(Instant::now() + Duration::from_secs(85))
    }
    fn expired(&mut self, cx: &mut Context<'_>) -> bool {
        self.idle.as_mut().poll(cx).is_ready()
    }
}
impl<T: AsyncRead + Unpin> AsyncRead for ProgressIo<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.expired(cx) {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Socket idle timeout",
            )));
        }
        let before = buf.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        if buf.filled().len() > before {
            self.progress();
            let mut clock = self.clock.lock().unwrap();
            clock.last_read = Some(Instant::now());
            if !clock.handling {
                clock.started.get_or_insert_with(Instant::now);
            }
        }
        result
    }
}
impl<T: AsyncWrite + Unpin> AsyncWrite for ProgressIo<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.expired(cx) {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Socket idle timeout",
            )));
        }
        let result = Pin::new(&mut self.inner).poll_write(cx, bytes);
        if matches!(result,Poll::Ready(Ok(n)) if n>0) {
            self.progress()
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
pub async fn connection<F, R>(stream: TcpStream, route: F, mut stop: watch::Receiver<bool>)
where
    F: Fn(Request<Incoming>) -> R,
    R: Future<Output = Result<HttpResponse, Infallible>>,
{
    let mut builder = http1::Builder::new();
    builder
        .timer(TokioTimer::new())
        .header_read_timeout(Duration::from_secs(10));
    let io = ProgressIo::new(stream);
    let clock = io.clock.clone();
    let conn = builder.serve_connection(
        TokioIo::new(io),
        service_fn(move |mut request: Request<Incoming>| {
            {
                let mut clock = clock.lock().unwrap();
                request.extensions_mut().insert(RequestStart(
                    clock
                        .started
                        .take()
                        .or(clock.last_read)
                        .unwrap_or_else(Instant::now),
                ));
                clock.handling = true;
            }
            let result = route(request);
            let clock = clock.clone();
            async move {
                let result = result.await;
                clock.lock().unwrap().handling = false;
                result
            }
        }),
    );
    tokio::pin!(conn);
    tokio::select! {_=&mut conn=>{},_=stop.changed()=>{conn.as_mut().graceful_shutdown();let _=conn.await;}}
}
pub async fn serve(
    listener: TcpListener,
    app: Arc<HttpApp>,
    stop: impl Future<Output = ()>,
) -> io::Result<()> {
    let (shutdown, rx) = watch::channel(false);
    let mut tasks = JoinSet::new();
    tokio::pin!(stop);
    loop {
        tokio::select! {
            _=&mut stop=>break,
            accepted=listener.accept()=>{let (stream,_)=accepted?;let app=app.clone();let rx=rx.clone();tasks.spawn(async move {connection(stream,move |request|{let app=app.clone();async move {app.handle(request).await}},rx).await;});},
            Some(_)=tasks.join_next()=>{}
        }
    }
    app.coordinator.stop_dispatch();
    let _ = shutdown.send(true);
    let coordinator = app.coordinator.clone();
    let drain = tokio::task::spawn_blocking(move || coordinator.shutdown());
    while tasks.join_next().await.is_some() {}
    drain
        .await
        .map_err(io::Error::other)?
        .map_err(io::Error::other)
}
