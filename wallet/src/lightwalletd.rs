//! Connection to a lightwalletd server (gRPC over TLS), optionally through Tor.

use anyhow::{anyhow, Context};
use hyper_util::rt::TokioIo;
use rand::{rngs::OsRng, RngCore};
use tokio_socks::tcp::Socks5Stream;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Uri};
use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;

pub type Client = CompactTxStreamerClient<Channel>;

#[derive(Clone, Debug)]
pub struct Endpoint {
    pub url: String,
    /// Extra PEM CA bundle to trust, for networks that re-sign TLS at an egress proxy.
    pub extra_ca_pem: Option<Vec<u8>>,
    /// A SOCKS5 proxy (`host:port`, normally Tor) to reach lightwalletd through.
    /// The server then sees a Tor exit instead of this server's address.
    pub socks_proxy: Option<String>,
}

impl Endpoint {
    /// Whether connections are isolated from each other: each gets its own Tor circuit.
    pub fn isolated(&self) -> bool {
        self.socks_proxy.is_some()
    }

    pub async fn connect(&self) -> anyhow::Result<Client> {
        let uri: Uri = self.url.parse().context("invalid lightwalletd URL")?;
        let host = uri.host().ok_or_else(|| anyhow!("lightwalletd URL has no host"))?.to_string();
        let mut channel = Channel::from_shared(self.url.clone())?
            .connect_timeout(std::time::Duration::from_secs(if self.isolated() { 60 } else { 20 }))
            .timeout(std::time::Duration::from_secs(120));
        if uri.scheme_str() == Some("https") {
            let mut tls = ClientTlsConfig::new()
                .domain_name(host)
                .assume_http2(true)
                .with_webpki_roots();
            if let Some(pem) = &self.extra_ca_pem {
                tls = tls.ca_certificate(Certificate::from_pem(pem));
            }
            channel = channel.tls_config(tls)?;
        }
        let channel = match &self.socks_proxy {
            None => channel.connect().await,
            Some(proxy) => {
                let proxy = proxy.clone();
                channel
                    .connect_with_connector(tower::service_fn(move |uri: Uri| {
                        let proxy = proxy.clone();
                        async move { socks_connect(&proxy, &uri).await }
                    }))
                    .await
            }
        }
        .with_context(|| format!("connecting to lightwalletd at {}", self.url))?;
        Ok(CompactTxStreamerClient::new(channel))
    }
}

/// Opens a TCP stream to `uri` through a SOCKS5 proxy. The proxy resolves the
/// host name, so no DNS query leaves this server either. Tor gives each
/// distinct SOCKS login its own circuit, so a random one per connection keeps
/// connections from being linked to each other at the exit.
async fn socks_connect(proxy: &str, uri: &Uri) -> anyhow::Result<TokioIo<tokio::net::TcpStream>> {
    let host = uri.host().ok_or_else(|| anyhow!("lightwalletd URL has no host"))?;
    let port = uri.port_u16().unwrap_or(if uri.scheme_str() == Some("https") { 443 } else { 80 });
    let mut login = [0u8; 16];
    OsRng.fill_bytes(&mut login);
    let stream = Socks5Stream::connect_with_password(proxy, (host, port), &hex::encode(login), "unlisted")
        .await
        .with_context(|| format!("connecting through the SOCKS proxy at {proxy}"))?;
    Ok(TokioIo::new(stream.into_inner()))
}
