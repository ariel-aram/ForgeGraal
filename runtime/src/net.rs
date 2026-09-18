//! TCP and TLS sockets, exposed to JavaScript.
//!
//! This is the capability the JavaScript layer cannot provide for itself: quickjs-ng's own
//! `qjs:os` module has no socket API at all, which is why `net`, `tls`, `http` and everything
//! built on them (all of discord.js) stop dead on the engine alone.
//!
//! Sockets live here in Rust and are handed to JavaScript as integer ids. Keeping the streams on
//! this side rather than exposing raw file descriptors means a JavaScript bug cannot produce a use
//! after free or a descriptor mix-up: an unknown id is an error, not undefined behaviour.
//!
//! TLS uses rustls with its own webpki root store, deliberately not the operating system's. That
//! matches what Node does (it verifies against a bundled Mozilla CA snapshot) and it is what makes
//! an old machine able to reach Discord at all: the certificate store on a Windows 7 install is
//! typically a decade stale, while the roots compiled in here are current.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::{client::TlsStream, TlsConnector};

/// Either kind of connection, behind one interface so the JavaScript side does not branch.
enum Stream {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

impl Stream {
    async fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Stream::Plain(s) => s.read(buf).await,
            Stream::Tls(s) => s.read(buf).await,
        }
    }

    async fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        match self {
            Stream::Plain(s) => s.write_all(buf).await,
            Stream::Tls(s) => s.write_all(buf).await,
        }
    }

    async fn shutdown(&mut self) -> std::io::Result<()> {
        match self {
            Stream::Plain(s) => s.shutdown().await,
            Stream::Tls(s) => s.shutdown().await,
        }
    }
}

#[derive(Clone, Default)]
pub struct Sockets {
    inner: Arc<Mutex<HashMap<u32, Stream>>>,
    next_id: Arc<AtomicU32>,
}

impl Sockets {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            // Ids start at 1 so that 0 is never a valid socket, which makes an uninitialised
            // value on the JavaScript side fail loudly instead of addressing a real connection.
            next_id: Arc::new(AtomicU32::new(1)),
        }
    }

    /// Opens a connection, optionally wrapping it in TLS, and returns its id.
    pub async fn connect(&self, host: String, port: u16, tls: bool) -> Result<u32, String> {
        let tcp = TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|e| format!("connect to {host}:{port} failed: {e}"))?;
        // Disable Nagle: the gateway sends many small frames and latency matters more than
        // packing them.
        let _ = tcp.set_nodelay(true);

        let stream = if tls {
            let connector = TlsConnector::from(tls_config());
            let server_name = ServerName::try_from(host.clone())
                .map_err(|_| format!("'{host}' is not a valid TLS server name"))?
                .to_owned();
            let tls_stream = connector
                .connect(server_name, tcp)
                .await
                .map_err(|e| format!("TLS handshake with {host} failed: {e}"))?;
            Stream::Tls(Box::new(tls_stream))
        } else {
            Stream::Plain(tcp)
        };

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.inner.lock().await.insert(id, stream);
        Ok(id)
    }

    /// Reads whatever is available. An empty result means the peer closed the connection.
    pub async fn read(&self, id: u32) -> Result<Vec<u8>, String> {
        let mut guard = self.inner.lock().await;
        let stream = guard.get_mut(&id).ok_or_else(|| unknown(id))?;
        let mut buf = vec![0u8; 65536];
        let read = stream.read(&mut buf).await.map_err(|e| format!("read on socket {id} failed: {e}"))?;
        buf.truncate(read);
        Ok(buf)
    }

    pub async fn write(&self, id: u32, data: Vec<u8>) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        let stream = guard.get_mut(&id).ok_or_else(|| unknown(id))?;
        stream.write_all(&data).await.map_err(|e| format!("write on socket {id} failed: {e}"))
    }

    pub async fn close(&self, id: u32) -> Result<(), String> {
        let mut stream = match self.inner.lock().await.remove(&id) {
            Some(stream) => stream,
            // Closing twice is not an error: a JavaScript stream may well call destroy() after
            // the peer already went away.
            None => return Ok(()),
        };
        let _ = stream.shutdown().await;
        Ok(())
    }
}

fn unknown(id: u32) -> String {
    format!("socket {id} does not exist (it was closed, or never opened)")
}

/// Built once: assembling the root store and config per connection would re-parse every root
/// certificate on each request.
fn tls_config() -> Arc<ClientConfig> {
    use std::sync::OnceLock;
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            // Selected explicitly rather than left to feature detection: more than one provider
            // can end up enabled through the dependency graph, and rustls then refuses to guess.
            // ring is also the provider that cross-compiles cleanly to the 32-bit targets this
            // project exists for.
            let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();

            let roots = RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };
            let config = ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth();
            Arc::new(config)
        })
        .clone()
}
