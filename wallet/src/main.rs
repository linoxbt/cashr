//! unlisted-wallet: a light-client Zcash wallet service for Unlisted.
//!
//! It syncs from a public lightwalletd server (no full node needed), keeps one
//! ZIP 32 account per event, decrypts incoming memos, and builds and
//! broadcasts Orchard-only refunds. It exposes the zcashd JSON-RPC methods the
//! Unlisted API uses, so the API can also run against zcashd or Zallet.

mod cache;
mod lightwalletd;
mod rpc;
mod wallet;

use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{bail, Context};
use axum::{routing::post, Router};
use secrecy::SecretVec;
use tracing::{error, info, warn};
use zcash_protocol::consensus::Network;

use crate::{lightwalletd::Endpoint, rpc::RpcState, wallet::Wallet};

struct Config {
    network: Network,
    data_dir: PathBuf,
    lightwalletd: String,
    extra_ca: Option<PathBuf>,
    listen: SocketAddr,
    rpc_user: String,
    rpc_password: String,
    sync_interval: Duration,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

impl Config {
    fn from_env() -> anyhow::Result<Self> {
        let network = match env("UW_NETWORK").as_deref().unwrap_or("main") {
            "main" => Network::MainNetwork,
            "test" => Network::TestNetwork,
            other => bail!("UW_NETWORK must be main or test, not {other}"),
        };
        let default_lwd = if network == Network::MainNetwork { "https://zec.rocks:443" } else { "https://testnet.zec.rocks:443" };
        let cfg = Self {
            network,
            data_dir: env("UW_DATA_DIR").unwrap_or_else(|| "./wallet-data".into()).into(),
            lightwalletd: env("UW_LIGHTWALLETD").unwrap_or_else(|| default_lwd.into()),
            extra_ca: env("UW_EXTRA_CA_FILE").map(PathBuf::from),
            listen: env("UW_LISTEN").unwrap_or_else(|| "127.0.0.1:8232".into()).parse().context("UW_LISTEN")?,
            rpc_user: env("UW_RPC_USER").unwrap_or_default(),
            rpc_password: env("UW_RPC_PASSWORD").unwrap_or_default(),
            sync_interval: Duration::from_secs(env("UW_SYNC_INTERVAL").and_then(|s| s.parse().ok()).unwrap_or(10)),
        };
        if !cfg.listen.ip().is_loopback() && cfg.rpc_password.is_empty() {
            bail!("refusing to listen on {} without UW_RPC_PASSWORD", cfg.listen);
        }
        Ok(cfg)
    }
}

/// Load the wallet's BIP 39 mnemonic, creating one on first start. Back this
/// file up: it controls every event's deposits.
fn load_or_create_seed(dir: &Path) -> anyhow::Result<SecretVec<u8>> {
    let path = dir.join("seed.txt");
    let phrase = if path.exists() {
        std::fs::read_to_string(&path)?.trim().to_string()
    } else {
        let mnemonic = bip39::Mnemonic::generate_in_with(&mut rand::rngs::OsRng, bip39::Language::English, 24)?;
        let phrase = mnemonic.to_string();
        write_private(&path, phrase.as_bytes())?;
        warn!(path = %path.display(), "created a new wallet seed; back this file up");
        phrase
    };
    let mnemonic = bip39::Mnemonic::parse_in(bip39::Language::English, &phrase).context("seed.txt is not a valid BIP 39 phrase")?;
    Ok(SecretVec::new(mnemonic.to_seed("").to_vec()))
}

fn write_private(path: &Path, data: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    opts.open(path)?.write_all(data)?;
    Ok(())
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let cfg = Config::from_env()?;
    std::fs::create_dir_all(&cfg.data_dir)?;
    let seed = load_or_create_seed(&cfg.data_dir)?;
    let extra_ca_pem = cfg.extra_ca.as_ref().map(std::fs::read).transpose().context("UW_EXTRA_CA_FILE")?;
    let endpoint = Endpoint { url: cfg.lightwalletd.clone(), extra_ca_pem };
    let wallet = Wallet::open(cfg.network, cfg.data_dir.join("wallet.sqlite"), seed, endpoint)?;

    let syncer = Arc::clone(&wallet);
    let interval = cfg.sync_interval;
    tokio::spawn(async move {
        loop {
            match syncer.sync_once().await {
                Ok(()) => info!(tip = syncer.tip(), scanned = syncer.scanned(), "synced"),
                Err(e) => error!(error = %format!("{e:#}"), "sync failed; retrying"),
            }
            tokio::time::sleep(interval).await;
        }
    });

    let auth = (!cfg.rpc_password.is_empty()).then(|| rpc::basic_auth(&cfg.rpc_user, &cfg.rpc_password));
    let state = Arc::new(RpcState { wallet, auth, lightwalletd: cfg.lightwalletd.clone() });
    let app = Router::new().route("/", post(rpc::handle)).with_state(state);
    let listener = tokio::net::TcpListener::bind(cfg.listen).await?;
    info!(listen = %cfg.listen, lightwalletd = %cfg.lightwalletd, "unlisted-wallet ready");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
