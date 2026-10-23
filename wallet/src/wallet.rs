//! The wallet: one account per cashr event, each from its own seed.

use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc,
    },
};

use anyhow::{anyhow, bail};
use rand::{rngs::OsRng, RngCore};
use secrecy::ExposeSecret;
use tokio::sync::Mutex;
use tonic::Code;
use tracing::{debug, error, info, warn};
use zcash_address::ZcashAddress;
use zcash_client_backend::{
    data_api::{
        wallet::{
            create_proposed_transactions, decrypt_and_store_transaction,
            input_selection::{GreedyInputSelector, LockedInputPolicy, SpendPolicy},
            propose_send_max_transfer, propose_transfer, ConfirmationsPolicy, SpendingKeys,
        },
        Account as _, AccountBirthday, MaxSpendMode, TransactionDataRequest, TransactionStatus, WalletRead,
        WalletWrite,
    },
    fees::{zip317::SingleOutputChangeStrategy, DustOutputPolicy, StandardFeeRule},
    proto::service::{BlockId, ChainSpec, RawTransaction, TxFilter},
    wallet::OvkPolicy,
};
use rusqlite::OptionalExtension;
use zcash_client_sqlite::{util::SystemClock, AccountUuid, WalletDb};
use zcash_keys::{
    address::{Address, UnifiedAddress},
    keys::{ReceiverRequirement, ReceiverRequirements, UnifiedAddressRequest, UnifiedSpendingKey},
};
use zcash_primitives::transaction::{Transaction, TxId};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, Network, Parameters},
    memo::MemoBytes,
    value::Zatoshis,
    ShieldedPool,
};
use zip321::{Payment, TransactionRequest};

use crate::{
    cache::MemBlockCache,
    keys::SeedStore,
    lightwalletd::{Client, Endpoint},
    ops::{Op, OpStore},
};

/// The wallet refuses to delete an account holding more than this.
pub const DELETE_MAX_ZAT: u64 = 20_000;
/// Longest a single sync may hold the writer.
const SYNC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
/// Syncs in a row a received transaction may be missing from lightwalletd
/// (about an hour at the default interval) before its memo is given up on.
const ENHANCE_MAX_MISSES: u32 = 360;
/// A received transaction is fetched this many seconds after it is first seen.
const ENHANCE_DELAY_MIN_S: u32 = 60;
const ENHANCE_DELAY_MAX_S: u32 = 300;
/// Blocks past its expiry height before an unmined transaction counts as
/// expired, so a short reorg can't make a transaction that may still be mined
/// look dead (and be rebuilt).
const EXPIRY_DEPTH: u32 = 10;
/// Set while a delete's file rewrite is owed.
const COMPACT_FLAG: &str = "compact_after_delete";
/// A delete needs a sync this recent: an older one may have missed a payment.
const DELETE_SYNC_FRESH_S: u64 = 60;
/// Account creation gives up rather than finish after the API's own 180 s timeout,
/// which would leave an account (and seed) nobody knows about.
const CREATE_NETWORK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const CREATE_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(100);
/// The whole of account creation, connecting included; well inside the API's 180 s.
const CREATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(150);
/// `scan_queue` priority codes (zcash_client_sqlite): above this, a range still needs scanning.
const PRIORITY_SCANNED: i64 = 10;

pub type Db = WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>;

#[derive(Clone, Debug)]
pub enum OpState {
    Executing,
    /// Built and broadcast at least once (not necessarily mined).
    Success { txid: String, amount: Option<u64> },
    /// Nothing was broadcast.
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TxState {
    Mined { confirmations: u32 },
    /// Not mined yet, and can still be.
    Pending,
    /// Not mined, and past its expiry height: it can never be mined.
    Expired,
}

pub enum SendKind {
    Transfer(TransactionRequest),
    /// Everything spendable, minus the fee, to one address.
    Sweep { to: ZcashAddress, memo: MemoBytes },
}

#[derive(Clone, Debug)]
pub struct Recipient {
    pub address: String,
    pub amount: Zatoshis,
    pub memo: MemoBytes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrivacyPolicy {
    /// Only Orchard outputs: nothing about the send is revealed on chain.
    FullPrivacy,
    /// Sapling recipients are allowed, which reveals the amount crossing pools.
    AllowRevealedAmounts,
}

impl PrivacyPolicy {
    pub fn parse(s: Option<&str>) -> anyhow::Result<Self> {
        match s.unwrap_or("FullPrivacy") {
            "FullPrivacy" => Ok(Self::FullPrivacy),
            "AllowRevealedAmounts" => Ok(Self::AllowRevealedAmounts),
            other => bail!("unsupported privacy policy {other}"),
        }
    }
}

pub struct ReceivedOutput {
    pub txid: String,
    pub pool: &'static str,
    pub index: u32,
    pub value: u64,
    pub memo: Vec<u8>,
    pub mined_height: Option<u32>,
}

pub struct Wallet {
    pub params: Network,
    /// The writer: sync, account creation, building transactions.
    db: Mutex<Db>,
    db_path: PathBuf,
    seeds: SeedStore,
    ops: OpStore,
    /// Serialises the idempotency check-and-set in `submit`.
    submit_lock: std::sync::Mutex<()>,
    cache: MemBlockCache,
    endpoint: Endpoint,
    client: Mutex<Option<Client>>,
    tip: AtomicU32,
    scanned: AtomicU32,
    /// Unix time of the last sync that reached lightwalletd's tip.
    last_sync: AtomicU64,
    prover: LocalTxProver,
    /// How many syncs in a row lightwalletd answered "not found" for a received transaction.
    misses: Mutex<std::collections::HashMap<TxId, u32>>,
    /// When each received transaction may be fetched, and when each sent one's
    /// status may be asked for next (see `due`).
    deferred: Mutex<std::collections::HashMap<TxId, std::time::Instant>>,
    status_due: Mutex<std::collections::HashMap<TxId, std::time::Instant>>,
}

impl Wallet {
    pub fn open(params: Network, data_dir: &std::path::Path, seed_key_hex: &str, endpoint: Endpoint) -> anyhow::Result<Arc<Self>> {
        let db_path = data_dir.join("wallet.sqlite");
        // WAL rather than a rollback journal: a delete's rollback journal holds the
        // deleted account's keys and memos, and is unlinked without being overwritten.
        // (The mode is stored in the file; SQLite is built with secure delete on.)
        rusqlite::Connection::open(&db_path)?.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
        let mut db = WalletDb::for_path(&db_path, params, SystemClock, OsRng)?;
        zcash_client_sqlite::wallet::init::init_wallet_db(&mut db, None)
            .map_err(|e| anyhow!("wallet database migration failed: {e:?}"))?;
        let tip = db.chain_height()?.map(u32::from).unwrap_or(0);
        let scanned = scanned_through(&rusqlite::Connection::open(&db_path)?, tip)?;
        let seeds = SeedStore::open(&data_dir.join("seeds"), seed_key_hex)?;
        recover_staged_seeds(&params, &db, &seeds)?;
        let ops = OpStore::open(&data_dir.join("ops.sqlite"))?;
        ops.prune(30)?;
        let owes_compaction = ops.flag(COMPACT_FLAG)?;
        let wallet = Arc::new(Self {
            params,
            db: Mutex::new(db),
            db_path,
            seeds,
            ops,
            submit_lock: Default::default(),
            cache: MemBlockCache::default(),
            endpoint,
            client: Mutex::new(None),
            tip: AtomicU32::new(tip),
            scanned: AtomicU32::new(scanned),
            last_sync: AtomicU64::new(0),
            prover: LocalTxProver::bundled(),
            misses: Default::default(),
            deferred: Default::default(),
            status_due: Default::default(),
        });
        if owes_compaction {
            // A delete's rewrite was interrupted by a restart: finish it before serving.
            wallet.compact_now();
        }
        Ok(wallet)
    }

    /// A separate connection for reads, so RPC calls never wait for a sync
    /// (which holds the writer for whole batches) to finish.
    fn reader(&self) -> anyhow::Result<Db> {
        Ok(WalletDb::for_path(&self.db_path, self.params, SystemClock, OsRng)?)
    }

    /// Rewrites the database so deleted rows leave no trace in free pages or the WAL.
    fn compact(&self) -> anyhow::Result<()> {
        let conn = rusqlite::Connection::open(&self.db_path)?;
        conn.busy_timeout(std::time::Duration::from_secs(30))?;
        conn.execute_batch("VACUUM;")?;
        // (busy, frames in the log, frames checkpointed): only an empty log is done.
        let (busy, frames): (i64, i64) =
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
        if busy != 0 || frames > 0 {
            bail!("the wallet log is still in use by a reader; the rewrite will be retried");
        }
        Ok(())
    }

    fn read_conn(&self) -> anyhow::Result<rusqlite::Connection> {
        let conn = rusqlite::Connection::open_with_flags(&self.db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        Ok(conn)
    }

    pub fn parse_account(account: &str) -> anyhow::Result<AccountUuid> {
        Ok(AccountUuid::from_uuid(uuid::Uuid::parse_str(account).map_err(|_| anyhow!("account must be a UUID"))?))
    }

    async fn client(&self) -> anyhow::Result<Client> {
        let mut slot = self.client.lock().await;
        if slot.is_none() {
            *slot = Some(self.endpoint.connect().await?);
        }
        Ok(slot.as_ref().unwrap().clone())
    }

    async fn drop_client(&self) {
        *self.client.lock().await = None;
    }

    pub fn tip(&self) -> u32 {
        self.tip.load(Ordering::Relaxed)
    }

    pub fn scanned(&self) -> u32 {
        self.scanned.load(Ordering::Relaxed)
    }

    /// Seconds since the last sync that reached lightwalletd's tip (None before the first).
    pub fn last_sync_age(&self) -> Option<u64> {
        match self.last_sync.load(Ordering::Relaxed) {
            0 => None,
            t => Some(unix_now().saturating_sub(t)),
        }
    }

    // ---- sync -------------------------------------------------------------

    /// Bring the wallet up to the chain tip, then fetch the full transactions
    /// it needs: compact blocks carry no memos, and memos are the whole point.
    pub async fn sync_once(&self) -> anyhow::Result<()> {
        let mut client = self.client().await?;
        let result = self.sync_inner(&mut client).await;
        if result.is_err() {
            self.drop_client().await;
        }
        result
    }

    async fn sync_inner(&self, client: &mut Client) -> anyhow::Result<()> {
        let tip = {
            let mut db = self.db.lock().await;
            if db.get_account_ids()?.is_empty() {
                // Nothing to scan for yet; just track the tip.
                let latest = client.get_latest_block(ChainSpec::default()).await?.into_inner();
                self.tip.store(latest.height as u32, Ordering::Relaxed);
                self.last_sync.store(unix_now(), Ordering::Relaxed);
                return Ok(());
            }
            // Bounded, so a stalled block stream can't hold the writer forever.
            tokio::time::timeout(SYNC_TIMEOUT, zcash_client_backend::sync::run(client, &self.params, &self.cache, &mut *db, 1000))
                .await
                .map_err(|_| anyhow!("sync timed out"))?
                .map_err(|e| anyhow!("sync failed: {e}"))?;
            let tip = db.chain_height()?.ok_or_else(|| anyhow!("chain height unknown after sync"))?;
            // Stored before fetching memos, so confirmations and expiry keep
            // moving even while a transaction can't be fetched.
            self.tip.store(u32::from(tip), Ordering::Relaxed);
            self.scanned.store(scanned_through(&self.read_conn()?, u32::from(tip))?, Ordering::Relaxed);
            self.last_sync.store(unix_now(), Ordering::Relaxed);
            tip
        };
        self.enhance(client, tip).await;
        Ok(())
    }

    /// Fetch the full transactions the wallet asks for. Network fetches happen
    /// without the writer lock, so account creation and sends never queue
    /// behind them. A failed fetch is logged and retried on the next sync; it
    /// never stops the others.
    async fn enhance(&self, client: &mut Client, tip: BlockHeight) {
        let mut done = BTreeSet::new();
        loop {
            let requests = match self.db.lock().await.transaction_data_requests() {
                Ok(r) => r.into_iter().filter(|r| !done.contains(r)).collect::<Vec<_>>(),
                Err(e) => return warn!(error = %e, "could not list the transactions to fetch"),
            };
            if done.is_empty() {
                // The first pass sees every request the wallet still has.
                self.forget_settled(&requests).await;
            }
            if requests.is_empty() {
                return;
            }
            for request in requests {
                if !self.due(&request).await {
                    done.insert(request);
                    continue;
                }
                if let Err(e) = self.serve(client, tip, &request).await {
                    warn!(error = %format!("{e:#}"), "could not fetch a transaction; retrying on the next sync");
                }
                done.insert(request);
            }
        }
    }

    /// Whether to fetch a transaction now. A deposit's transaction is fetched a
    /// random 1–5 minutes after the wallet first sees it, so the server's fetches
    /// (even over Tor) don't follow each broadcast closely enough for a sync
    /// server to pick out which transactions are RSVPs by timing.
    async fn due(&self, request: &TransactionDataRequest) -> bool {
        if let TransactionDataRequest::GetStatus(txid) = request {
            // A sent transaction's status, asked for every 1–3 minutes rather than at
            // every sync: each ask is a fresh Tor circuit and a request lightwalletd sees.
            let mut next = self.status_due.lock().await;
            let now = std::time::Instant::now();
            if next.get(txid).is_some_and(|at| now < *at) {
                return false;
            }
            let jitter = (OsRng.next_u32() % 121) as u64;
            next.insert(*txid, now + std::time::Duration::from_secs(60 + jitter));
            return true;
        }
        let TransactionDataRequest::Enhancement(txid) = request else { return true };
        let mut deferred = self.deferred.lock().await;
        let at = *deferred.entry(*txid).or_insert_with(|| {
            let jitter = (OsRng.next_u32() % (ENHANCE_DELAY_MAX_S - ENHANCE_DELAY_MIN_S + 1)) as u64;
            std::time::Instant::now() + std::time::Duration::from_secs(ENHANCE_DELAY_MIN_S as u64 + jitter)
        });
        if std::time::Instant::now() < at {
            return false;
        }
        deferred.remove(txid);
        true
    }

    /// Drops timers and miss counts for transactions the wallet no longer asks
    /// about (fetched, or their account deleted), so they don't pile up.
    async fn forget_settled(&self, requests: &[TransactionDataRequest]) {
        let wanted = |txid: &TxId, status: bool| {
            requests.iter().any(|r| match r {
                TransactionDataRequest::GetStatus(t) => status && t == txid,
                TransactionDataRequest::Enhancement(t) => !status && t == txid,
                #[allow(unreachable_patterns)]
                _ => false,
            })
        };
        self.deferred.lock().await.retain(|t, _| wanted(t, false));
        self.misses.lock().await.retain(|t, _| wanted(t, false));
        self.status_due.lock().await.retain(|t, _| wanted(t, true));
    }

    async fn serve(&self, client: &mut Client, tip: BlockHeight, request: &TransactionDataRequest) -> anyhow::Result<()> {
        match request {
            TransactionDataRequest::GetStatus(txid) => {
                let status = match self.fetch_tx_isolated(client, tip, *txid).await? {
                    None => TransactionStatus::TxidNotRecognized,
                    Some((_, Some(h))) => TransactionStatus::Mined(h),
                    Some((_, None)) => TransactionStatus::NotInMainChain,
                };
                self.db.lock().await.set_transaction_status(*txid, status)?;
            }
            TransactionDataRequest::Enhancement(txid) => match self.fetch_tx_isolated(client, tip, *txid).await? {
                Some((tx, mined)) => {
                    self.misses.lock().await.remove(txid);
                    let mut db = self.db.lock().await;
                    // Fetched without the lock: if the account it belonged to was
                    // deleted meanwhile, the request is gone, and storing the
                    // transaction would leave a trace of a purged event.
                    if !db.transaction_data_requests()?.contains(request) {
                        return Ok(());
                    }
                    decrypt_and_store_transaction(&self.params, &mut *db, &tx, mined)?;
                }
                None => {
                    // The wallet saw this transaction in a block, so "not found" means
                    // the server is lagging. Marking it unrecognised would drop its
                    // memo, and with it an RSVP, for good: retry instead, and give up
                    // only after many syncs.
                    let mut misses = self.misses.lock().await;
                    let n = misses.entry(*txid).or_insert(0);
                    *n += 1;
                    if *n >= ENHANCE_MAX_MISSES {
                        misses.remove(txid);
                        drop(misses);
                        error!("lightwalletd never returned a transaction this wallet received; its memo is lost");
                        self.db.lock().await.set_transaction_status(*txid, TransactionStatus::TxidNotRecognized)?;
                    }
                }
            },
            #[allow(unreachable_patterns)]
            _ => {}
        }
        Ok(())
    }

    /// Fetches one of this wallet's transactions. Through Tor, each fetch gets a
    /// fresh connection and circuit, so lightwalletd can't group the transactions
    /// one server asks about (an event's deposits) by connection.
    async fn fetch_tx_isolated(
        &self,
        client: &mut Client,
        tip: BlockHeight,
        txid: TxId,
    ) -> anyhow::Result<Option<(Transaction, Option<BlockHeight>)>> {
        if !self.endpoint.isolated() {
            return self.fetch_tx(client, tip, txid).await;
        }
        let mut fresh = self.endpoint.connect().await?;
        self.fetch_tx(&mut fresh, tip, txid).await
    }

    async fn fetch_tx(
        &self,
        client: &mut Client,
        tip: BlockHeight,
        txid: TxId,
    ) -> anyhow::Result<Option<(Transaction, Option<BlockHeight>)>> {
        let req = TxFilter { hash: txid.as_ref().to_vec(), ..Default::default() };
        let raw = match client.get_transaction(req).await {
            Ok(r) => r.into_inner(),
            Err(s) if s.code() == Code::NotFound => return Ok(None),
            Err(s) => return Err(s.into()),
        };
        let mined = (raw.height > 0 && raw.height <= u64::from(u32::MAX)).then(|| BlockHeight::from_u32(raw.height as u32));
        let tx = Transaction::read(&raw.data[..], BranchId::for_height(&self.params, mined.unwrap_or(tip)))?;
        Ok(Some((tx, mined)))
    }

    // ---- accounts -----------------------------------------------------------

    /// Create a fresh account, from a fresh seed, whose birthday is the
    /// current tip so it never scans history. Returns the account's UUID.
    pub async fn new_account(&self) -> anyhow::Result<String> {
        // Only waits are cut short: once the writer is held there is no await left,
        // so the account and its seed are never split by the timeout.
        tokio::time::timeout(CREATE_TIMEOUT, self.new_account_inner())
            .await
            .map_err(|_| anyhow!("creating the account took too long; try again"))?
    }

    async fn new_account_inner(&self) -> anyhow::Result<String> {
        let mut client = self.client().await?;
        let latest = tokio::time::timeout(CREATE_NETWORK_TIMEOUT, client.get_latest_block(ChainSpec::default()))
            .await
            .map_err(|_| anyhow!("lightwalletd did not answer in time"))??
            .into_inner();
        let treestate = tokio::time::timeout(
            CREATE_NETWORK_TIMEOUT,
            client.get_tree_state(BlockId { height: latest.height.saturating_sub(1), ..Default::default() }),
        )
        .await
        .map_err(|_| anyhow!("lightwalletd did not answer in time"))??
        .into_inner();
        let birthday = AccountBirthday::from_treestate(treestate, None)
            .map_err(|e| anyhow!("bad tree state from lightwalletd: {e:?}"))?;
        let seed = SeedStore::generate();
        // The seed is on disk before the account exists, so funds sent to the
        // account can always be spent.
        let staged = self.seeds.stage(&seed)?;
        let Ok(mut db) = tokio::time::timeout(CREATE_LOCK_TIMEOUT, self.db.lock()).await else {
            self.seeds.discard(&staged);
            bail!("the wallet is busy syncing; try again shortly");
        };
        let created = db.create_account("cashr-event", &seed, &birthday, None);
        let (uuid, _) = match created {
            Ok(v) => v,
            Err(e) => {
                self.seeds.discard(&staged);
                return Err(e.into());
            }
        };
        let account = uuid.expose_uuid().to_string();
        self.seeds.commit(&staged, &account)?;
        // Debug only: a timestamped line per account would date each event past its purge.
        debug!(%account, birthday = latest.height, "created an event account");
        Ok(account)
    }

    pub async fn address_for(&self, account: &str, orchard: bool, sapling: bool) -> anyhow::Result<String> {
        let req = |on: bool| if on { ReceiverRequirement::Require } else { ReceiverRequirement::Omit };
        let request = UnifiedAddressRequest::Custom(
            ReceiverRequirements::new(req(orchard), req(sapling), ReceiverRequirement::Omit)
                .map_err(|_| anyhow!("a unified address needs a shielded receiver"))?,
        );
        let uuid = Self::parse_account(account)?;
        let mut db = self.db.lock().await;
        let (ua, _) = db
            .get_next_available_address(uuid, request)?
            .ok_or_else(|| anyhow!("no address available"))?;
        Ok(ua.encode(&self.params))
    }

    /// (spendable, pending) zatoshis. Pending is received or change value
    /// still waiting for confirmations.
    pub fn balance(&self, account: &str) -> anyhow::Result<(u64, u64)> {
        let uuid = Self::parse_account(account)?;
        let db = self.reader()?;
        if !db.get_account_ids()?.contains(&uuid) {
            if self.ops.was_deleted(account)? {
                bail!("account {account} was deleted");
            }
            bail!("no account {account}");
        }
        let Some(summary) = db.get_wallet_summary(ConfirmationsPolicy::default())? else {
            // Not "empty": the wallet can't tell yet (it hasn't synced). Saying 0
            // here would let an account holding money be deleted.
            bail!("the wallet hasn't synced far enough to report balances; try again shortly");
        };
        Ok(summary
            .account_balances()
            .get(&uuid)
            .map(|b| {
                let pools = [b.orchard_balance(), b.sapling_balance(), b.ironwood_balance()];
                let spendable: u64 = pools.iter().map(|p| p.spendable_value().into_u64()).sum();
                // Everything else worth having: unconfirmed and locked value. Notes too
                // small to pay their own fee are left out: they can never be spent at a
                // profit, and counting them let anyone block an event's settlement and
                // purge for good by sending it dust.
                let held: u64 = pools.iter().map(|p| p.total().into_u64()).sum();
                (spendable, held.saturating_sub(spendable))
            })
            .unwrap_or((0, 0)))
    }

    /// Value received by this account whose memo hasn't been read yet: the wallet
    /// spends it like any other, but nobody knows yet whether it is an RSVP to keep
    /// or a payment to return. Payments whose memo the wallet gave up on don't count.
    pub fn awaiting_memo(&self, account: &str) -> anyhow::Result<u64> {
        let uuid = Self::parse_account(account)?;
        let waiting: Vec<TxId> = self
            .reader()?
            .transaction_data_requests()?
            .into_iter()
            .filter_map(|r| match r {
                TransactionDataRequest::Enhancement(txid) => Some(txid),
                #[allow(unreachable_patterns)]
                _ => None,
            })
            .collect();
        if waiting.is_empty() {
            return Ok(0);
        }
        let conn = self.read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT t.txid, ro.value FROM v_received_outputs ro
               JOIN transactions t ON t.id_tx = ro.transaction_id
               JOIN accounts a ON a.id = ro.account_id
              WHERE a.uuid = ?1 AND ro.is_change = 0 AND ro.memo IS NULL",
        )?;
        let rows = stmt.query_map([uuid.expose_uuid().as_bytes().to_vec()], |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, i64>(1)?)))?;
        let mut total = 0u64;
        for row in rows {
            let (txid, value) = row?;
            let txid = TxId::from_bytes(txid.try_into().map_err(|_| anyhow!("bad txid length"))?);
            if waiting.contains(&txid) {
                total += value.max(0) as u64;
            }
        }
        Ok(total)
    }

    /// Every non-change output received at `address` whose memo is known.
    /// Outputs found by compact scanning wait here until their full
    /// transaction has been fetched, so a caller never sees a memo-less note.
    /// Mined at or after `since` (or not mined yet).
    pub fn received_at(&self, address: &str, since: u32) -> anyhow::Result<Vec<ReceivedOutput>> {
        let conn = self.read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT t.txid, t.mined_height, ro.pool, ro.output_index, ro.value, ro.memo
             FROM v_received_outputs ro
             JOIN transactions t ON t.id_tx = ro.transaction_id
             JOIN addresses a ON a.id = ro.address_id
             WHERE a.address = ?1 AND ro.is_change = 0 AND ro.memo IS NOT NULL
               AND (t.mined_height IS NULL OR t.mined_height >= ?2)",
        )?;
        let rows = stmt.query_map(rusqlite::params![address, since], |row| {
            let txid: Vec<u8> = row.get(0)?;
            Ok((txid, row.get::<_, Option<u32>>(1)?, row.get::<_, i64>(2)?, row.get::<_, u32>(3)?,
                row.get::<_, i64>(4)?, row.get::<_, Vec<u8>>(5)?))
        })?;
        let mut out = vec![];
        for row in rows {
            let (txid, mined_height, pool, index, value, memo) = row?;
            let txid = TxId::from_bytes(txid.try_into().map_err(|_| anyhow!("bad txid length"))?);
            out.push(ReceivedOutput {
                txid: txid.to_string(),
                pool: pool_name(pool),
                index,
                value: value as u64,
                memo,
                mined_height,
            });
        }
        Ok(out)
    }

    pub fn account_for_address(&self, address: &str) -> anyhow::Result<String> {
        let conn = self.read_conn()?;
        let uuid: Option<Vec<u8>> = conn
            .query_row(
                "SELECT acc.uuid FROM addresses ad JOIN accounts acc ON acc.id = ad.account_id WHERE ad.address = ?1",
                [address],
                |r| r.get(0),
            )
            .optional()?;
        let uuid = uuid.ok_or_else(|| anyhow!("from address does not belong to this wallet"))?;
        Ok(uuid::Uuid::from_slice(&uuid)?.to_string())
    }

    /// The last block at or before `unix_time`, if the wallet holds it and the
    /// block right after it (so a gap in the stored blocks can't pass off an older
    /// block as the last one before that time). None leaves the caller to estimate.
    pub fn height_at(&self, unix_time: i64) -> anyhow::Result<Option<u32>> {
        let conn = self.read_conn()?;
        Ok(conn
            .query_row(
                "SELECT b.height FROM blocks b JOIN blocks n ON n.height = b.height + 1
                  WHERE b.time <= ?1 AND n.time > ?1 ORDER BY b.height DESC LIMIT 1",
                [unix_time],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Where a transaction this wallet built stands on chain.
    pub fn tx_state(&self, txid: &str) -> anyhow::Result<Option<TxState>> {
        let id = TxId::from_hex(txid).ok_or_else(|| anyhow!("bad txid"))?;
        let conn = self.read_conn()?;
        let row: Option<(Option<u32>, Option<u32>)> = conn
            .query_row(
                "SELECT mined_height, expiry_height FROM transactions WHERE txid = ?1",
                [id.as_ref().to_vec()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(row.map(|(mined, expiry)| match (mined, expiry) {
            (Some(h), _) => TxState::Mined { confirmations: self.confirmations(Some(h)) },
            // Expired once every block up to its expiry height has been scanned without it.
            (None, Some(e)) if e != 0 && self.scanned() > e.saturating_add(EXPIRY_DEPTH) => TxState::Expired,
            _ => TxState::Pending,
        }))
    }

    /// Delete an event's account, its transactions and memos, and its seed.
    ///
    /// Idempotent: deleting an account that is already gone finishes whatever an
    /// interrupted delete left behind (seed, operations) and succeeds, so a caller
    /// that timed out can simply ask again.
    pub async fn delete_account(self: &Arc<Self>, account: &str) -> anyhow::Result<()> {
        let uuid = Self::parse_account(account)?;
        let mut deleted = false;
        if self.reader()?.get_account_ids()?.contains(&uuid) {
            self.ensure_deletable(account, uuid)?;
            let mut db = self.db.lock().await;
            // Again under the writer lock: no send can start building from here on.
            self.ensure_deletable(account, uuid)?;
            // Recorded first, so a retry after a crash or timeout knows the account
            // was deleted here, and the file rewrite is owed even across a restart.
            self.ops.mark_deleted(account)?;
            self.ops.set_flag(COMPACT_FLAG, true)?;
            db.delete_account(uuid)?;
            deleted = true;
        } else if !self.ops.was_deleted(account)? {
            // Not a retry: the wallet database may have been reset or restored from
            // an older backup. The seed could be the only way to funds on chain.
            bail!("no account {account}, and no record of deleting it; refusing to delete its seed");
        }
        self.seeds.delete(account)?;
        self.ops.delete_account(account)?;
        debug!(%account, "deleted an event account and its seed");
        if deleted {
            // Freed pages and the WAL still hold the deleted keys and memos until the
            // file is rewritten. That can take a while, so it runs after replying.
            let wallet = Arc::clone(self);
            tokio::spawn(async move {
                let _writer = wallet.db.lock().await;
                tokio::task::block_in_place(|| wallet.compact_now());
            });
        }
        Ok(())
    }

    /// Rewrite the database if a delete still owes it (also run at startup).
    fn compact_now(&self) {
        match self.compact().and_then(|_| self.ops.set_flag(COMPACT_FLAG, false)) {
            Ok(()) => {}
            Err(e) => error!(error = %format!("{e:#}"),
                "could not rewrite the wallet database after a delete; retrying at the next start"),
        }
    }

    /// Refuses while anything could still move this account's money: deleting
    /// the seed would destroy it. Covers unconfirmed value, sends being built,
    /// and built transactions that could still be mined (their inputs show in
    /// no balance until they expire).
    fn ensure_deletable(&self, account: &str, uuid: AccountUuid) -> anyhow::Result<()> {
        sync_allows_delete(self.last_sync.load(Ordering::Relaxed), unix_now(), self.scanned(), self.tip())?;
        let (spendable, pending) = self.balance(account)?;
        if spendable + pending > DELETE_MAX_ZAT {
            bail!("account still holds {} zatoshis; sweep it before deleting", spendable + pending);
        }
        for op in self.ops.for_account(account)? {
            if op.state == "executing" {
                bail!("a send from this account is still being built; try again once it finishes");
            }
            if let Some(txid) = &op.txid {
                if matches!(self.tx_state(txid)?, Some(TxState::Pending)) {
                    bail!("a send from this account could still be mined; try again once it confirms or expires");
                }
            }
        }
        let conn = self.read_conn()?;
        let in_flight: i64 = conn.query_row(
            "SELECT COUNT(*) FROM (
               SELECT t.id_tx FROM orchard_received_note_spends s
                 JOIN orchard_received_notes n ON n.id = s.orchard_received_note_id
                 JOIN accounts a ON a.id = n.account_id
                 JOIN transactions t ON t.id_tx = s.transaction_id
                WHERE a.uuid = ?1 AND t.mined_height IS NULL
                  AND (t.expiry_height IS NULL OR t.expiry_height = 0 OR t.expiry_height + ?3 >= ?2)
               UNION
               SELECT t.id_tx FROM sapling_received_note_spends s
                 JOIN sapling_received_notes n ON n.id = s.sapling_received_note_id
                 JOIN accounts a ON a.id = n.account_id
                 JOIN transactions t ON t.id_tx = s.transaction_id
                WHERE a.uuid = ?1 AND t.mined_height IS NULL
                  AND (t.expiry_height IS NULL OR t.expiry_height = 0 OR t.expiry_height + ?3 >= ?2)
               UNION
               SELECT t.id_tx FROM ironwood_received_note_spends s
                 JOIN ironwood_received_notes n ON n.id = s.ironwood_received_note_id
                 JOIN accounts a ON a.id = n.account_id
                 JOIN transactions t ON t.id_tx = s.transaction_id
                WHERE a.uuid = ?1 AND t.mined_height IS NULL
                  AND (t.expiry_height IS NULL OR t.expiry_height = 0 OR t.expiry_height + ?3 >= ?2))",
            rusqlite::params![uuid.expose_uuid().as_bytes().to_vec(), self.scanned(), EXPIRY_DEPTH],
            |r| r.get(0),
        )?;
        if in_flight > 0 {
            bail!("a transaction spending this account's funds could still be mined; try again once it expires");
        }
        Ok(())
    }

    // ---- sending ------------------------------------------------------------

    pub fn op_status(&self, opid: &str) -> anyhow::Result<Option<OpState>> {
        Ok(self.ops.get(opid)?.map(|op| match (op.state.as_str(), op.txid) {
            ("executing", _) => OpState::Executing,
            // A failed broadcast may still have reached the network: the
            // caller tracks the transaction rather than assuming nothing was sent.
            (_, Some(txid)) => OpState::Success { txid, amount: op.amount },
            _ => OpState::Failed(op.error),
        }))
    }

    pub fn transfer_request(&self, recipients: Vec<Recipient>, policy: PrivacyPolicy) -> anyhow::Result<SendKind> {
        let mut payments = Vec::with_capacity(recipients.len());
        for r in &recipients {
            payments.push(Payment::new(self.shielded_target(&r.address, policy)?, Some(r.amount), Some(r.memo.clone()), None, None, vec![])
                .map_err(|e| anyhow!("invalid payment: {e:?}"))?);
        }
        Ok(SendKind::Transfer(TransactionRequest::new(payments).map_err(|e| anyhow!("invalid request: {e:?}"))?))
    }

    pub fn sweep_request(&self, to: &str, memo: MemoBytes) -> anyhow::Result<SendKind> {
        Ok(SendKind::Sweep { to: self.shielded_target(to, PrivacyPolicy::FullPrivacy)?, memo })
    }

    /// Submit a send under an idempotency key. Never builds a second
    /// transaction for a key while an earlier one could still be mined:
    /// a pending one is rebroadcast, a mined one is left alone, and only one
    /// that failed before broadcast, or expired unmined, is rebuilt.
    pub fn submit(self: &Arc<Self>, key: &str, account: &str, kind: SendKind) -> anyhow::Result<String> {
        if key.is_empty() || key.len() > 64 {
            bail!("an idempotency key of 1-64 characters is required");
        }
        let _guard = self.submit_lock.lock().unwrap();
        let existing = self.ops.by_key(key)?;
        let (opid, attempt) = match existing {
            None => {
                let opid = format!("opid-{}", uuid::Uuid::new_v4());
                self.ops.insert(&opid, key, account)?;
                (opid, 0)
            }
            Some(Op { account: ref a, .. }) if a != account => bail!("idempotency key already used by another account"),
            Some(op) if op.state == "executing" => return Ok(op.opid),
            Some(Op { opid, txid: Some(txid), .. }) => match self.tx_state(&txid)? {
                Some(TxState::Mined { .. }) => return Ok(opid),
                Some(TxState::Pending) => {
                    let wallet = Arc::clone(self);
                    tokio::spawn(async move { wallet.rebroadcast(&txid).await });
                    return Ok(opid);
                }
                Some(TxState::Expired) => {
                    // Txids stay out of the logs: they outlive a purge and match attendees' wallets.
                    debug!(%txid, "transaction expired unmined; building a replacement");
                    info!("transaction expired unmined; building a replacement");
                    let attempt = self.ops.restart(&opid)?;
                    (opid, attempt)
                }
                None => {
                    debug!(%txid, "transaction for this key is unknown");
                    bail!("the transaction for this key is unknown to the wallet; refusing to send again")
                }
            },
            Some(op) => {
                let attempt = self.ops.restart(&op.opid)?;
                (op.opid, attempt)
            }
        };
        // The build runs in its own task so a panic (in proving, say) is caught
        // here and recorded, instead of leaving the operation executing forever.
        let wallet = Arc::clone(self);
        let (id, account) = (opid.clone(), account.to_string());
        tokio::spawn(async move {
            let build = {
                let (wallet, id) = (Arc::clone(&wallet), id.clone());
                tokio::spawn(async move { wallet.build_and_broadcast(&id, attempt, &account, kind).await })
            };
            let (state, error) = match build.await {
                Ok(Ok(txid)) => {
                    debug!(%txid, "broadcast");
                    ("success", String::new())
                }
                Ok(Err(e)) => {
                    warn!(error = %e, "send failed");
                    ("failed", e.to_string())
                }
                Err(e) => {
                    error!(error = %e, "send task crashed");
                    ("failed", "the send crashed; check the wallet log".to_string())
                }
            };
            // An operation left "executing" would block its key and its account's
            // delete until a restart, so recording the outcome is retried.
            for delay in [0u64, 1, 5, 30] {
                tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                match wallet.ops.finish(&id, attempt, state, &error) {
                    Ok(()) => return,
                    Err(e) => error!(error = %e, "could not record how a send ended; retrying"),
                }
            }
        });
        Ok(opid)
    }

    /// Send an already-built transaction again. It never touches the
    /// operation's state: the operation may have moved on (expired and been
    /// rebuilt) by the time this finishes, and must not be overwritten.
    async fn rebroadcast(&self, txid: &str) {
        let result = async {
            let id = TxId::from_hex(txid).ok_or_else(|| anyhow!("bad txid"))?;
            let tx = self.reader()?.get_transaction(id)?.ok_or_else(|| anyhow!("transaction not found"))?;
            let mut raw = RawTransaction::default();
            tx.write(&mut raw.data)?;
            self.broadcast(raw).await
        }
        .await;
        if let Err(e) = result {
            debug!(%txid, "rebroadcast failed");
            warn!(error = %e, "rebroadcast failed")
        }
    }

    async fn broadcast(&self, raw: RawTransaction) -> anyhow::Result<()> {
        // Through Tor, every broadcast (and rebroadcast) gets its own connection and
        // circuit: on the long-lived sync connection, lightwalletd could group every
        // transaction this server sends.
        let mut client = if self.endpoint.isolated() { self.endpoint.connect().await? } else { self.client().await? };
        let resp = client.send_transaction(raw).await?.into_inner();
        let msg = resp.error_message.to_lowercase();
        // Already known to the node: that is what a rebroadcast hopes for.
        if resp.error_code != 0 && msg.contains("txn-mempool-conflict") {
            // A different transaction spending the same notes is in the mempool.
            // Only this wallet can spend them, so it is one of ours; whichever is
            // mined wins, and the other expires. Worth knowing, not failing.
            warn!("broadcast conflicts with another transaction of this wallet in the mempool");
        } else if resp.error_code != 0 && !msg.contains("already") {
            bail!("lightwalletd rejected the transaction ({}): {}", resp.error_code, resp.error_message);
        }
        Ok(())
    }

    /// Resolve a recipient to the receiver we will actually pay. Under
    /// FullPrivacy only an Orchard receiver is acceptable, so funds never
    /// leave the Orchard pool and no amount is revealed.
    fn shielded_target(&self, address: &str, policy: PrivacyPolicy) -> anyhow::Result<ZcashAddress> {
        let decoded = Address::decode(&self.params, address).ok_or_else(|| anyhow!("invalid recipient address"))?;
        match decoded {
            Address::Unified(ua) => {
                if let Some(o) = ua.orchard() {
                    let orchard_only = UnifiedAddress::from_receivers(Some(*o), None, None)
                        .ok_or_else(|| anyhow!("could not build Orchard-only address"))?;
                    return Ok(Address::from(orchard_only).to_zcash_address(&self.params));
                }
                if policy == PrivacyPolicy::AllowRevealedAmounts && ua.sapling().is_some() {
                    return Ok(Address::from(ua).to_zcash_address(&self.params));
                }
                bail!("Recipient has no Orchard receiver; refusing under {policy:?}")
            }
            Address::Sapling(_) if policy == PrivacyPolicy::AllowRevealedAmounts => {
                Ok(decoded.to_zcash_address(&self.params))
            }
            _ => bail!("Recipient must be a shielded Orchard address under {policy:?}"),
        }
    }

    async fn build_and_broadcast(&self, opid: &str, attempt: i64, account: &str, kind: SendKind) -> anyhow::Result<String> {
        let uuid = Self::parse_account(account)?;
        let seed = self.seeds.load(account)?;
        let usk = UnifiedSpendingKey::from_seed(&self.params, seed.expose_secret(), zip32::AccountId::ZERO)
            .map_err(|e| anyhow!("key derivation failed: {e:?}"))?;
        let (txid, amount, raw) = {
            let mut db = self.db.lock().await;
            // A seed file renamed or restored under the wrong account must never
            // be used to sign for it.
            match db.get_account_for_ufvk(&usk.to_unified_full_viewing_key())? {
                Some(a) if a.id() == uuid => {}
                _ => bail!("the seed stored for this account does not match it; refusing to sign"),
            }
            let proposal = match kind {
                SendKind::Transfer(request) => {
                    let change = SingleOutputChangeStrategy::new(
                        StandardFeeRule::Zip317,
                        None,
                        ShieldedPool::Orchard,
                        DustOutputPolicy::default(),
                    );
                    propose_transfer::<_, _, _, _, std::convert::Infallible>(
                        &mut *db,
                        &self.params,
                        uuid,
                        &GreedyInputSelector::new(),
                        &change,
                        request,
                        ConfirmationsPolicy::default(),
                        &SpendPolicy::default(),
                        None,
                        None,
                    )
                    .map_err(|e| anyhow!("{e}"))?
                }
                SendKind::Sweep { to, memo } => propose_send_max_transfer::<_, _, _, std::convert::Infallible>(
                    &mut *db,
                    &self.params,
                    uuid,
                    // The pools to empty. Since NU6.3 every payment to an Orchard receiver
                    // lands in the Ironwood pool (Orchard takes no new value), so an event's
                    // deposits are Ironwood notes; a sweep of Orchard alone found nothing.
                    &[sweep_pool(&self.params, self.tip())],
                    &StandardFeeRule::Zip317,
                    to,
                    Some(memo),
                    // Fails while any funds are unconfirmed, so nothing is left behind.
                    MaxSpendMode::Everything,
                    ConfirmationsPolicy::default(),
                    &LockedInputPolicy::default(),
                    None,
                )
                .map_err(|e| anyhow!("{e}"))?,
            };
            let amount = proposal
                .steps()
                .first()
                .transaction_request()
                .total()
                .ok()
                .flatten()
                .map(|z| z.into_u64())
                .unwrap_or(0);
            // Proving is CPU-bound; keep it off the async workers.
            let txids = tokio::task::block_in_place(|| {
                create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
                    &mut *db,
                    &self.params,
                    &self.prover,
                    &self.prover,
                    &SpendingKeys::from_unified_spending_key(usk),
                    OvkPolicy::Sender,
                    &proposal,
                    None,
                )
            })
            .map_err(|e| anyhow!("{e}"))?;
            if txids.len() > 1 {
                bail!("multi-transaction proposals are not supported");
            }
            let tx = db.get_transaction(*txids.first())?.ok_or_else(|| anyhow!("built transaction not found"))?;
            let mut raw = RawTransaction::default();
            tx.write(&mut raw.data)?;
            (tx.txid(), amount, raw)
        };
        // Recorded before broadcasting: from here on, this key's money may be on its way.
        // Refused if this attempt was superseded, and then nothing is broadcast: the
        // built transaction's notes are released when it expires.
        self.ops.set_built(opid, attempt, &txid.to_string(), amount)?;
        self.broadcast(raw).await?;
        Ok(txid.to_string())
    }


    pub fn network_name(&self) -> &'static str {
        match self.params.network_type() {
            zcash_protocol::consensus::NetworkType::Main => "main",
            zcash_protocol::consensus::NetworkType::Test => "test",
            zcash_protocol::consensus::NetworkType::Regtest => "regtest",
        }
    }
}

/// The shielded pool an event's money sits in at `tip`: Ironwood once NU6.3 is active
/// (it took over new Orchard-receiver payments), Orchard before.
fn sweep_pool(params: &Network, tip: u32) -> ShieldedPool {
    match params.activation_height(zcash_protocol::consensus::NetworkUpgrade::Nu6_3) {
        Some(h) if BlockHeight::from_u32(tip) >= h => ShieldedPool::Ironwood,
        _ => ShieldedPool::Orchard,
    }
}

/// zcash_client_sqlite's pool codes, as named in the RPC.
fn pool_name(code: i64) -> &'static str {
    match code {
        2 => "sapling",
        3 => "orchard",
        4 => "ironwood",
        _ => "other",
    }
}

/// A balance only covers the blocks scanned so far: after downtime, or while
/// syncs fail, a payment can sit in blocks the wallet hasn't seen yet.
fn sync_allows_delete(last_sync: u64, now: u64, scanned: u32, tip: u32) -> anyhow::Result<()> {
    if last_sync == 0 || now.saturating_sub(last_sync) > DELETE_SYNC_FRESH_S {
        bail!("the wallet hasn't synced recently, so it can't be sure this account is empty; try again shortly");
    }
    if scanned < tip {
        bail!("the wallet is still scanning blocks that may hold this account's funds; try again shortly");
    }
    Ok(())
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The height up to which every block that can hold this wallet's funds has been
/// scanned: the block before the lowest range still waiting to be scanned, or the
/// tip when none is. librustzcash's `block_fully_scanned` stops at the first gap
/// after the oldest scanned range, and a deleted account's history (marked
/// Ignored, never scanned) leaves exactly such a gap, so it stops moving for good
/// and an expired send could never be seen as expired.
fn scanned_through(conn: &rusqlite::Connection, tip: u32) -> anyhow::Result<u32> {
    let unscanned: Option<u32> = conn.query_row(
        "SELECT MIN(block_range_start) FROM scan_queue
          WHERE priority > ?1
            AND block_range_end > (SELECT IFNULL(MIN(birthday_height), 0) FROM accounts)",
        [PRIORITY_SCANNED],
        |r| r.get(0),
    )?;
    Ok(match unscanned {
        Some(start) => start.saturating_sub(1).min(tip),
        None => tip,
    })
}

/// A create interrupted between creating the account and committing its seed
/// leaves the seed under its staged name: commit it to the account it belongs
/// to, or the account's funds could never be spent. A staged seed with no
/// account was never used and is discarded.
fn recover_staged_seeds(params: &Network, db: &Db, seeds: &SeedStore) -> anyhow::Result<()> {
    for staged in seeds.staged()? {
        // A seed cut short by a crash while it was being written can't belong to an
        // account (accounts are created only after staging finishes). Set it aside
        // rather than refuse to start.
        let ufvk = match seeds.load(&staged).and_then(|seed| {
            UnifiedSpendingKey::from_seed(params, seed.expose_secret(), zip32::AccountId::ZERO)
                .map_err(|e| anyhow!("key derivation failed: {e:?}"))
        }) {
            Ok(usk) => usk.to_unified_full_viewing_key(),
            Err(e) => {
                error!(error = %format!("{e:#}"), "set aside an unreadable staged seed");
                seeds.quarantine(&staged)?;
                continue;
            }
        };
        match db.get_account_for_ufvk(&ufvk)? {
            Some(account) => {
                seeds.commit(&staged, &account.id().expose_uuid().to_string())?;
                warn!("recovered the seed of an account whose creation was interrupted");
            }
            None => seeds.discard(&staged),
        }
    }
    Ok(())
}

impl Wallet {
    pub fn confirmations(&self, mined: Option<u32>) -> u32 {
        match mined {
            Some(h) if self.tip() >= h => self.tip() - h + 1,
            _ => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_temp(dir: &std::path::Path) -> anyhow::Result<Arc<Wallet>> {
        // Nothing here talks to lightwalletd: opening the wallet never connects.
        let endpoint = Endpoint { url: "https://127.0.0.1:1".into(), extra_ca_pem: None, socks_proxy: None };
        Wallet::open(Network::TestNetwork, dir, &"07".repeat(32), endpoint)
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("uw-wallet-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn scan_queue(ranges: &[(u32, u32, i64)], birthdays: &[u32]) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE scan_queue (block_range_start INTEGER, block_range_end INTEGER, priority INTEGER);
             CREATE TABLE accounts (birthday_height INTEGER);",
        )
        .unwrap();
        for (a, b, p) in ranges {
            conn.execute("INSERT INTO scan_queue VALUES (?1, ?2, ?3)", rusqlite::params![a, b, p]).unwrap();
        }
        for b in birthdays {
            conn.execute("INSERT INTO accounts VALUES (?1)", [b]).unwrap();
        }
        conn
    }

    #[test]
    fn a_deleted_accounts_history_does_not_pin_the_scanned_height() {
        // The live wallet's queue: a deleted account left a Scanned range, then an
        // Ignored gap below the live accounts' birthdays. librustzcash reported
        // 3526965 here forever, so no send could ever be seen as expired.
        let live = scan_queue(
            &[(419_200, 3_526_928, 0), (3_526_928, 3_526_966, 10), (3_526_966, 3_527_083, 0), (3_527_083, 3_527_291, 10)],
            &[3_527_167, 3_527_243],
        );
        assert_eq!(scanned_through(&live, 3_527_290).unwrap(), 3_527_290);
        // New blocks waiting to be scanned stop it just below them.
        let behind = scan_queue(&[(3_527_083, 3_527_291, 10), (3_527_291, 3_527_300, 50)], &[3_527_167]);
        assert_eq!(scanned_through(&behind, 3_527_299).unwrap(), 3_527_290);
        // An unscanned gap after downtime does too, even with later blocks scanned.
        let gap = scan_queue(&[(3_527_100, 3_527_150, 10), (3_527_150, 3_527_200, 20), (3_527_200, 3_527_300, 10)], &[3_527_100]);
        assert_eq!(scanned_through(&gap, 3_527_299).unwrap(), 3_527_149);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn deleted_rows_leave_no_journal_and_are_overwritten() {
        let dir = temp_dir();
        let wallet = open_temp(&dir).unwrap();
        let conn = rusqlite::Connection::open(&wallet.db_path).unwrap();
        // WAL: no rollback journal holding deleted keys gets unlinked unwritten.
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "wal");
        // Built in (.cargo/config.toml), so it holds for zcash_client_sqlite's own connections too.
        let secure: i64 = conn.query_row("PRAGMA secure_delete", [], |r| r.get(0)).unwrap();
        assert_eq!(secure, 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sweeps_and_labels_follow_the_ironwood_upgrade() {
        // NU6.3 moved new Orchard-receiver payments into the Ironwood pool.
        assert_eq!(sweep_pool(&Network::MainNetwork, 3_527_900), ShieldedPool::Ironwood);
        assert_eq!(sweep_pool(&Network::MainNetwork, 3_000_000), ShieldedPool::Orchard);
        assert_eq!(sweep_pool(&Network::TestNetwork, 4_532_700), ShieldedPool::Ironwood);
        assert_eq!(pool_name(4), "ironwood");
        assert_eq!(pool_name(3), "orchard");
    }

    #[test]
    fn a_seed_is_deleted_only_after_a_recent_complete_sync() {
        let now = 1_800_000_000;
        assert!(sync_allows_delete(0, now, 100, 100).is_err(), "never synced");
        assert!(sync_allows_delete(now - DELETE_SYNC_FRESH_S - 1, now, 100, 100).is_err(), "stale sync");
        assert!(sync_allows_delete(now - 5, now, 99, 100).is_err(), "blocks still unscanned");
        assert!(sync_allows_delete(now - 5, now, 100, 100).is_ok());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_unreadable_staged_seed_is_set_aside_not_fatal() {
        let dir = temp_dir();
        std::fs::create_dir_all(dir.join("seeds")).unwrap();
        // A staged seed cut short by a crash mid-write.
        std::fs::write(dir.join("seeds/staged-cut.seed"), b"short").unwrap();
        let _wallet = open_temp(&dir).expect("the wallet still starts");
        assert!(!dir.join("seeds/staged-cut.seed").exists());
        assert!(dir.join("seeds/staged-cut.unreadable").exists(), "kept, out of the way");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_missing_account_counts_as_deleted_only_if_this_wallet_deleted_it() {
        let dir = temp_dir();
        let wallet = open_temp(&dir).unwrap();
        let account = uuid::Uuid::new_v4().to_string();
        // Unknown and never deleted here (say, a reset wallet database): refused.
        let err = wallet.delete_account(&account).await.unwrap_err().to_string();
        assert!(err.contains("no record of deleting it"), "{err}");
        assert!(wallet.balance(&account).unwrap_err().to_string().contains("no account"));
        // Deleted here before (a retry after a timeout): succeeds, and says so.
        wallet.ops.mark_deleted(&account).unwrap();
        wallet.delete_account(&account).await.unwrap();
        assert!(wallet.balance(&account).unwrap_err().to_string().contains("was deleted"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_owed_rewrite_is_finished_at_startup() {
        let dir = temp_dir();
        drop(open_temp(&dir).unwrap());
        OpStore::open(&dir.join("ops.sqlite")).unwrap().set_flag(COMPACT_FLAG, true).unwrap();
        let wallet = open_temp(&dir).unwrap();
        assert!(!wallet.ops.flag(COMPACT_FLAG).unwrap(), "the restart finished the rewrite");
        assert_eq!(wallet.height_at(i64::MAX).unwrap(), None, "no blocks scanned yet");
        let _ = std::fs::remove_dir_all(dir);
    }
}
