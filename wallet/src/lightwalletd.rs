//! Connection to a lightwalletd server (gRPC over TLS).

use anyhow::{anyhow, Context};
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Uri};
use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;

pub type Client = CompactTxStreamerClient<Channel>;

#[derive(Clone, Debug)]
pub struct Endpoint {
    pub url: String,
    /// Extra PEM CA bundle to trust, for networks that re-sign TLS at an egress proxy.
    pub extra_ca_pem: Option<Vec<u8>>,
}

impl Endpoint {
    pub async fn connect(&self) -> anyhow::Result<Client> {
        let uri: Uri = self.url.parse().context("invalid lightwalletd URL")?;
        let host = uri.host().ok_or_else(|| anyhow!("lightwalletd URL has no host"))?.to_string();
        let mut channel = Channel::from_shared(self.url.clone())?
            .connect_timeout(std::time::Duration::from_secs(20))
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
        let channel = channel
            .connect()
            .await
            .with_context(|| format!("connecting to lightwalletd at {}", self.url))?;
        Ok(CompactTxStreamerClient::new(channel))
    }
}
