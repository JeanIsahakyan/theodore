//! The loopback redirect (RFC 8252 §7.3): a one-sign-in HTTP listener on
//! `127.0.0.1` that catches `GET <path>?code=…&state=…`, hands it to the
//! app, and answers the browser tab with the page the app picks.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use async_trait::async_trait;
use theodore_ports::{
    AccountError, AccountResult, CallbackListener, CallbackPage, CallbackParams, IncomingCallback,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use url::Url;

const MAX_REQUEST_HEAD: usize = 16 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the browser tab waits for the app to finish the code exchange.
const REPLY_TIMEOUT: Duration = Duration::from_secs(60);

/// A validated loopback redirect: where to bind, which path to answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redirect {
    pub url: Url,
    pub bind: SocketAddr,
}

/// Only `http` on a loopback host with an explicit port is accepted: the
/// browser must reach this process, and nothing else should.
pub fn parse_redirect(uri: &str) -> AccountResult<Redirect> {
    let url = Url::parse(uri)
        .map_err(|e| AccountError::Config(format!("redirect URI {uri:?} is not a URL: {e}")))?;
    if url.scheme() != "http" {
        return Err(AccountError::Config(format!(
            "redirect URI {uri:?} must be http://127.0.0.1:<port>/<path>"
        )));
    }
    let ip = match url.host() {
        Some(url::Host::Ipv4(ip)) if ip.is_loopback() => IpAddr::V4(ip),
        Some(url::Host::Ipv6(ip)) if ip.is_loopback() => IpAddr::V6(ip),
        Some(url::Host::Domain("localhost")) => IpAddr::V4(Ipv4Addr::LOCALHOST),
        _ => {
            return Err(AccountError::Config(format!(
                "redirect URI {uri:?} must point at a loopback address (127.0.0.1, [::1] or localhost)"
            )));
        }
    };
    let port = url.port().ok_or_else(|| {
        AccountError::Config(format!(
            "redirect URI {uri:?} needs an explicit port (0 picks a free one)"
        ))
    })?;
    Ok(Redirect {
        bind: SocketAddr::new(ip, port),
        url,
    })
}

/// The query of a request target (`/callback?code=…`), if its path is
/// `path`. Unknown keys are ignored; a repeated key keeps its first value.
pub fn parse_callback(target: &str, path: &str) -> Option<CallbackParams> {
    let url = Url::parse("http://127.0.0.1").ok()?.join(target).ok()?;
    if url.path() != path {
        return None;
    }
    let mut params = CallbackParams::default();
    for (k, v) in url.query_pairs() {
        let slot = match k.as_ref() {
            "code" => &mut params.code,
            "state" => &mut params.state,
            "error" => &mut params.error,
            "error_description" => &mut params.error_description,
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some(v.into_owned());
        }
    }
    Some(params)
}

/// The request target of an HTTP/1.x request head, for `GET` only.
fn request_target(head: &str) -> Option<&str> {
    let line = head.lines().next()?;
    let mut parts = line.split(' ');
    let method = parts.next()?;
    let target = parts.next()?;
    let version = parts.next()?;
    (method == "GET" && version.starts_with("HTTP/1.")).then_some(target)
}

pub struct LoopbackListener {
    rx: mpsc::Receiver<IncomingCallback>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for LoopbackListener {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[async_trait]
impl CallbackListener for LoopbackListener {
    async fn next(&mut self) -> AccountResult<IncomingCallback> {
        self.rx
            .recv()
            .await
            .ok_or_else(|| AccountError::Protocol("the loopback listener stopped".into()))
    }
}

/// Binds `redirect` now (so a taken port fails the sign-in up front) and
/// returns the redirect URL actually in use — port `0` becomes the port
/// the OS picked.
pub async fn listen(redirect: &Redirect) -> AccountResult<(Url, LoopbackListener)> {
    let socket = TcpListener::bind(redirect.bind).await.map_err(|e| {
        AccountError::Config(format!(
            "can't listen on {} for the sign-in redirect: {e}",
            redirect.bind
        ))
    })?;
    let local = socket
        .local_addr()
        .map_err(|e| AccountError::Config(e.to_string()))?;
    let mut url = redirect.url.clone();
    url.set_port(Some(local.port()))
        .map_err(|_| AccountError::Config("redirect URI can't take a port".into()))?;
    let path = url.path().to_string();
    let (tx, rx) = mpsc::channel(4);
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, peer)) = socket.accept().await else {
                return;
            };
            if !is_loopback(peer.ip()) {
                continue;
            }
            let tx = tx.clone();
            let path = path.clone();
            tokio::spawn(async move {
                let _ = serve(stream, &path, tx).await;
            });
        }
    });
    Ok((url, LoopbackListener { rx, task }))
}

fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
    }
}

async fn read_head(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < MAX_REQUEST_HEAD {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

async fn serve(
    mut stream: TcpStream,
    path: &str,
    tx: mpsc::Sender<IncomingCallback>,
) -> std::io::Result<()> {
    let head = tokio::time::timeout(READ_TIMEOUT, read_head(&mut stream))
        .await
        .map_err(|_| std::io::Error::other("timed out reading the request"))??;
    let Some(params) = request_target(&head).and_then(|t| parse_callback(t, path)) else {
        return respond(&mut stream, 404, "Not found", "Nothing here.").await;
    };
    let (reply_tx, reply_rx) = oneshot::channel();
    if tx
        .send(IncomingCallback {
            params,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return respond(
            &mut stream,
            410,
            "Sign-in closed",
            "This sign-in is no longer waiting. Start again from Theodore.",
        )
        .await;
    }
    let page = tokio::time::timeout(REPLY_TIMEOUT, reply_rx)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(CallbackPage::Failed {
            message: "Theodore didn't finish signing you in. Try again from the app.".into(),
        });
    match page {
        CallbackPage::SignedIn { email } => {
            respond(
                &mut stream,
                200,
                "You're signed in",
                &format!("Signed in to Theodore as {email}. You can close this tab and go back to the app."),
            )
            .await
        }
        CallbackPage::Failed { message } => {
            respond(&mut stream, 400, "Sign-in failed", &message).await
        }
        CallbackPage::Ignored => {
            respond(
                &mut stream,
                400,
                "Link out of date",
                "This sign-in link doesn't belong to the sign-in Theodore is waiting for. Use the newest browser tab, or start again.",
            )
            .await
        }
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn page_html(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{t} · Theodore</title>\
<style>body{{font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;\
min-height:90vh;margin:0;color:#222;background:#fafafa}}main{{max-width:420px;text-align:center}}\
h1{{font-size:20px;font-weight:600}}p{{color:#666;line-height:1.5}}\
@media(prefers-color-scheme:dark){{body{{background:#111;color:#eee}}p{{color:#aaa}}}}</style>\
</head><body><main><h1>{t}</h1><p>{b}</p></main></body></html>",
        t = escape(title),
        b = escape(body),
    )
}

async fn respond(
    stream: &mut TcpStream,
    status: u16,
    title: &str,
    body: &str,
) -> std::io::Result<()> {
    let html = page_html(title, body);
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        410 => "Gone",
        _ => "Bad Request",
    };
    let msg = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: text/html; charset=utf-8\r\n\
content-length: {}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n{html}",
        html.len()
    );
    stream.write_all(msg.as_bytes()).await?;
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::net::Ipv6Addr;

    #[test]
    fn redirect_accepts_loopback_hosts_only() {
        let r = parse_redirect("http://127.0.0.1:47823/callback").unwrap();
        assert_eq!(r.bind, "127.0.0.1:47823".parse().unwrap());
        assert_eq!(r.url.path(), "/callback");
        let r = parse_redirect("http://localhost:5000/cb").unwrap();
        assert_eq!(r.bind, "127.0.0.1:5000".parse().unwrap());
        let r = parse_redirect("http://[::1]:0/cb").unwrap();
        assert_eq!(r.bind, SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 0));

        for bad in [
            "https://127.0.0.1:5000/cb",
            "http://example.com:5000/cb",
            "http://10.0.0.1:5000/cb",
            "theodore://auth/callback",
            "http://127.0.0.1/cb",
            "not a url",
        ] {
            assert!(
                matches!(parse_redirect(bad), Err(AccountError::Config(_))),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn callback_parses_code_and_state() {
        let p = parse_callback("/callback?code=abc&state=s%2B1&extra=x", "/callback").unwrap();
        assert_eq!(p.code.as_deref(), Some("abc"));
        assert_eq!(p.state.as_deref(), Some("s+1"));
        assert_eq!(p.error, None);
    }

    #[test]
    fn callback_parses_provider_errors() {
        let p = parse_callback(
            "/callback?error=access_denied&error_description=User+cancelled&state=s",
            "/callback",
        )
        .unwrap();
        assert_eq!(p.code, None);
        assert_eq!(p.error.as_deref(), Some("access_denied"));
        assert_eq!(p.error_description.as_deref(), Some("User cancelled"));
    }

    #[test]
    fn callback_keeps_the_first_of_repeated_keys() {
        let p = parse_callback("/callback?state=first&state=second", "/callback").unwrap();
        assert_eq!(p.state.as_deref(), Some("first"));
    }

    #[test]
    fn other_paths_are_not_callbacks() {
        assert_eq!(parse_callback("/favicon.ico", "/callback"), None);
        assert_eq!(parse_callback("/callback/x?code=1", "/callback"), None);
    }

    #[test]
    fn request_target_needs_a_get() {
        assert_eq!(
            request_target("GET /callback?code=1 HTTP/1.1\r\nHost: x\r\n\r\n"),
            Some("/callback?code=1")
        );
        assert_eq!(request_target("POST /callback HTTP/1.1\r\n\r\n"), None);
        assert_eq!(request_target("garbage"), None);
    }

    #[test]
    fn page_html_escapes_text() {
        let html = page_html("Hi", "<script>x</script> & co");
        assert!(html.contains("&lt;script&gt;x&lt;/script&gt; &amp; co"));
        assert!(!html.contains("<script>x"));
    }

    async fn get(url: &str) -> (u16, String) {
        let u = Url::parse(url).unwrap();
        let mut s = TcpStream::connect((u.host_str().unwrap(), u.port().unwrap()))
            .await
            .unwrap();
        let target = match u.query() {
            Some(q) => format!("{}?{q}", u.path()),
            None => u.path().to_string(),
        };
        s.write_all(format!("GET {target} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        let status = out[9..12].parse().unwrap();
        (status, out)
    }

    #[tokio::test]
    async fn listener_hands_the_callback_over_and_shows_the_chosen_page() {
        let redirect = parse_redirect("http://127.0.0.1:0/callback").unwrap();
        let (url, mut listener) = listen(&redirect).await.unwrap();
        assert_ne!(url.port(), Some(0));
        assert_eq!(url.path(), "/callback");

        let base = url.to_string();
        let (status, _) = get(&base.replace("/callback", "/favicon.ico")).await;
        assert_eq!(status, 404);

        let browser = tokio::spawn({
            let base = base.clone();
            async move { get(&format!("{base}?code=c1&state=s1")).await }
        });
        let incoming = listener.next().await.unwrap();
        assert_eq!(incoming.params.code.as_deref(), Some("c1"));
        assert_eq!(incoming.params.state.as_deref(), Some("s1"));
        incoming
            .reply
            .send(CallbackPage::SignedIn {
                email: "ada@example.com".into(),
            })
            .unwrap();
        let (status, body) = browser.await.unwrap();
        assert_eq!(status, 200);
        assert!(body.contains("ada@example.com"));
    }

    #[tokio::test]
    async fn an_ignored_callback_keeps_the_listener_waiting() {
        let redirect = parse_redirect("http://127.0.0.1:0/cb").unwrap();
        let (url, mut listener) = listen(&redirect).await.unwrap();
        let base = url.to_string();

        let stale = tokio::spawn({
            let base = base.clone();
            async move { get(&format!("{base}?code=old&state=wrong")).await }
        });
        let first = listener.next().await.unwrap();
        first.reply.send(CallbackPage::Ignored).unwrap();
        assert_eq!(stale.await.unwrap().0, 400);

        let real = tokio::spawn(async move { get(&format!("{base}?code=new&state=right")).await });
        let second = listener.next().await.unwrap();
        assert_eq!(second.params.code.as_deref(), Some("new"));
        second
            .reply
            .send(CallbackPage::Failed {
                message: "nope".into(),
            })
            .unwrap();
        let (status, body) = real.await.unwrap();
        assert_eq!(status, 400);
        assert!(body.contains("nope"));
    }

    #[tokio::test]
    async fn a_taken_port_fails_up_front_and_dropping_frees_it() {
        let redirect = parse_redirect("http://127.0.0.1:0/cb").unwrap();
        let (url, listener) = listen(&redirect).await.unwrap();
        let taken = parse_redirect(url.as_str()).unwrap();
        assert!(matches!(listen(&taken).await, Err(AccountError::Config(_))));
        drop(listener);
        tokio::task::yield_now().await;
        // The accept task is aborted; binding the same port works again.
        let mut again = None;
        for _ in 0..50 {
            if let Ok(l) = listen(&taken).await {
                again = Some(l);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(again.is_some());
    }
}
