//! cashr-wallet: a light-client Zcash wallet service for cashr.
//!
//! It syncs from a public lightwalletd server (no full node needed), keeps one
//! account per event (each from its own seed, encrypted at rest), decrypts
//! incoming memos, and builds and broadcasts Orchard-only refunds. Sends are
//! idempotent and survive restarts. It serves the JSON-RPC methods the
//! cashr API uses.

mod cache;
mod keys;
mod lightwalletd;
mod ops;
mod rpc;
mod wallet;

use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{bail, Context};
use axum::{routing::post, Router};
use tracing::{error, info};
use zcash_protocol::consensus::Network;

use crate::{lightwalletd::Endpoint, rpc::RpcState, wallet::Wallet};

struct Config {
    network: Network,
    data_dir: PathBuf,
    lightwalletd: String,
    extra_ca: Option<PathBuf>,
    socks_proxy: Option<String>,
    listen: SocketAddr,
    rpc_user: String,
    rpc_password: String,
    seed_key: String,
    sync_interval: Duration,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

impl Config {
    fn from_env() -> anyhow::Result<Self> {
        let network = match env("CASHR_WALLET_NETWORK").as_deref().unwrap_or("main") {
            "main" => Network::MainNetwork,
            "test" => Network::TestNetwork,
            other => bail!("CASHR_WALLET_NETWORK must be main or test, not {other}"),
        };
        let default_lwd = if network == Network::MainNetwork { "https://zec.rocks:443" } else { "https://testnet.zec.rocks:443" };
        let cfg = Self {
            network,
            data_dir: env("CASHR_WALLET_DATA_DIR").unwrap_or_else(|| "./wallet-data".into()).into(),
            lightwalletd: env("CASHR_WALLET_LIGHTWALLETD").unwrap_or_else(|| default_lwd.into()),
            extra_ca: env("CASHR_WALLET_EXTRA_CA_FILE").map(PathBuf::from),
            // Normally Tor (host:port). Without it, lightwalletd's operator sees this
            // server's address fetch exactly the transactions that are RSVP deposits.
            socks_proxy: env("CASHR_WALLET_SOCKS_PROXY"),
            listen: env("CASHR_WALLET_LISTEN").unwrap_or_else(|| "127.0.0.1:8232".into()).parse().context("CASHR_WALLET_LISTEN")?,
            rpc_user: env("CASHR_WALLET_RPC_USER").unwrap_or_default(),
            rpc_password: env("CASHR_WALLET_RPC_PASSWORD").unwrap_or_default(),
            // Encrypts every event's seed at rest. Back it up with the data volume, separately.
            seed_key: env("CASHR_WALLET_SEED_KEY").context("set CASHR_WALLET_SEED_KEY to 64 hex characters (openssl rand -hex 32)")?,
            sync_interval: Duration::from_secs(env("CASHR_WALLET_SYNC_INTERVAL").and_then(|s| s.parse().ok()).unwrap_or(10)),
        };
        if !cfg.listen.ip().is_loopback() && cfg.rpc_password.is_empty() {
            bail!("refusing to listen on {} without CASHR_WALLET_RPC_PASSWORD", cfg.listen);
        }
        Ok(cfg)
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let cfg = Config::from_env()?;
    std::fs::create_dir_all(&cfg.data_dir)?;
    // The databases hold every live event's viewing keys and memos: owner only.
    #[cfg(unix)]
    std::fs::set_permissions(&cfg.data_dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    let extra_ca_pem = cfg.extra_ca.as_ref().map(std::fs::read).transpose().context("CASHR_WALLET_EXTRA_CA_FILE")?;
    let endpoint = Endpoint { url: cfg.lightwalletd.clone(), extra_ca_pem, socks_proxy: cfg.socks_proxy.clone() };
    let wallet = Wallet::open(cfg.network, &cfg.data_dir, &cfg.seed_key, endpoint)?;

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
    let via = cfg.socks_proxy.as_deref().unwrap_or("direct");
    info!(listen = %cfg.listen, lightwalletd = %cfg.lightwalletd, %via, "cashr-wallet ready");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
