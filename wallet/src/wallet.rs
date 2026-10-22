//! The wallet: one account per Unlisted event, each from its own seed.

use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
};

use anyhow::{anyhow, bail};
use rand::rngs::OsRng;
use secrecy::ExposeSecret;
use tokio::sync::Mutex;
use tonic::Code;
use tracing::{debug, info, warn};
use zcash_address::ZcashAddress;
use zcash_client_backend::{
    data_api::{
        wallet::{
            create_proposed_transactions, decrypt_and_store_transaction,
            input_selection::{GreedyInputSelector, LockedInputPolicy, SpendPolicy},
            propose_send_max_transfer, propose_transfer, ConfirmationsPolicy, SpendingKeys,
        },
        AccountBirthday, MaxSpendMode, TransactionDataRequest, TransactionStatus, WalletRead,
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
    prover: LocalTxProver,
}

impl Wallet {
    pub fn open(params: Network, data_dir: &std::path::Path, seed_key_hex: &str, endpoint: Endpoint) -> anyhow::Result<Arc<Self>> {
        let db_path = data_dir.join("wallet.sqlite");
        let mut db = WalletDb::for_path(&db_path, params, SystemClock, OsRng)?;
        zcash_client_sqlite::wallet::init::init_wallet_db(&mut db, None)
            .map_err(|e| anyhow!("wallet database migration failed: {e:?}"))?;
        let tip = db.chain_height()?.map(u32::from).unwrap_or(0);
        let scanned = db.block_fully_scanned()?.map(|m| u32::from(m.block_height())).unwrap_or(0);
        let seeds = SeedStore::open(&data_dir.join("seeds"), seed_key_hex)?;
        let ops = OpStore::open(&data_dir.join("ops.sqlite"))?;
        ops.prune(30)?;
        Ok(Arc::new(Self {
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
            prover: LocalTxProver::bundled(),
        }))
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
        conn.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")?;
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
        let mut db = self.db.lock().await;
        if db.get_account_ids()?.is_empty() {
            // Nothing to scan for yet; just track the tip.
            let latest = client.get_latest_block(ChainSpec::default()).await?.into_inner();
            self.tip.store(latest.height as u32, Ordering::Relaxed);
            return Ok(());
        }
        zcash_client_backend::sync::run(client, &self.params, &self.cache, &mut *db, 1000)
            .await
            .map_err(|e| anyhow!("sync failed: {e}"))?;
        let tip = db.chain_height()?.ok_or_else(|| anyhow!("chain height unknown after sync"))?;
        self.enhance(client, &mut db, tip).await?;
        self.tip.store(u32::from(tip), Ordering::Relaxed);
        if let Some(h) = db.block_fully_scanned()?.map(|m| u32::from(m.block_height())) {
            self.scanned.store(h, Ordering::Relaxed);
        }
        Ok(())
    }

    async fn enhance(&self, client: &mut Client, db: &mut Db, tip: BlockHeight) -> anyhow::Result<()> {
        let mut done = BTreeSet::new();
        loop {
            let requests: Vec<_> = db
                .transaction_data_requests()?
                .into_iter()
                .filter(|r| !done.contains(r))
                .collect();
            if requests.is_empty() {
                return Ok(());
            }
            for request in requests {
                match &request {
                    TransactionDataRequest::GetStatus(txid) => {
                        let status = match self.fetch_tx_isolated(client, tip, *txid).await? {
                            None => TransactionStatus::TxidNotRecognized,
                            Some((_, Some(h))) => TransactionStatus::Mined(h),
                            Some((_, None)) => TransactionStatus::NotInMainChain,
                        };
                        db.set_transaction_status(*txid, status)?;
                    }
                    TransactionDataRequest::Enhancement(txid) => match self.fetch_tx_isolated(client, tip, *txid).await? {
                        None => db.set_transaction_status(*txid, TransactionStatus::TxidNotRecognized)?,
                        Some((tx, mined)) => decrypt_and_store_transaction(&self.params, db, &tx, mined)?,
                    },
                    #[allow(unreachable_patterns)]
                    _ => {}
                }
                done.insert(request);
            }
        }
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
        let mut client = self.client().await?;
        let latest = client.get_latest_block(ChainSpec::default()).await?.into_inner();
        let treestate = client
            .get_tree_state(BlockId { height: latest.height.saturating_sub(1), ..Default::default() })
            .await?
            .into_inner();
        let birthday = AccountBirthday::from_treestate(treestate, None)
            .map_err(|e| anyhow!("bad tree state from lightwalletd: {e:?}"))?;
        let seed = SeedStore::generate();
        // The seed is on disk before the account exists, so funds sent to the
        // account can always be spent.
        let staged = self.seeds.stage(&seed)?;
        let mut db = self.db.lock().await;
        let created = db.create_account("unlisted-event", &seed, &birthday, None);
        let (uuid, _) = match created {
            Ok(v) => v,
            Err(e) => {
                self.seeds.discard(&staged);
                return Err(e.into());
            }
        };
        let account = uuid.expose_uuid().to_string();
        self.seeds.commit(&staged, &account)?;
        info!(%account, birthday = latest.height, "created account");
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
            bail!("no account {account}");
        }
        let Some(summary) = db.get_wallet_summary(ConfirmationsPolicy::default())? else {
            return Ok((0, 0));
        };
        Ok(summary
            .account_balances()
            .get(&uuid)
            .map(|b| {
                let pools = [b.orchard_balance(), b.sapling_balance()];
                let spendable = pools.iter().map(|p| p.spendable_value().into_u64()).sum();
                let pending = pools
                    .iter()
                    .map(|p| p.change_pending_confirmation().into_u64() + p.value_pending_spendability().into_u64())
                    .sum();
                (spendable, pending)
            })
            .unwrap_or((0, 0)))
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
                pool: match pool { 2 => "sapling", 3 => "orchard", _ => "other" },
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
            (None, Some(e)) if e != 0 && self.scanned() > e => TxState::Expired,
            _ => TxState::Pending,
        }))
    }

    /// Delete an event's account, its transactions and memos, and its seed.
    pub async fn delete_account(&self, account: &str) -> anyhow::Result<()> {
        let uuid = Self::parse_account(account)?;
        let (spendable, pending) = self.balance(account)?;
        if spendable + pending > DELETE_MAX_ZAT {
            bail!("account still holds {} zatoshis; sweep it before deleting", spendable + pending);
        }
        {
            let mut db = self.db.lock().await;
            db.delete_account(uuid)?;
            // Freed pages and the WAL still hold the deleted keys and memos until rewritten.
            if let Err(e) = self.compact() {
                warn!(%account, "could not compact the wallet database after delete: {e:#}");
            }
        }
        self.seeds.delete(account)?;
        self.ops.delete_account(account)?;
        info!(%account, "deleted account and its seed");
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
        let opid = match existing {
            None => {
                let opid = format!("opid-{}", uuid::Uuid::new_v4());
                self.ops.insert(&opid, key, account)?;
                opid
            }
            Some(Op { account: ref a, .. }) if a != account => bail!("idempotency key already used by another account"),
            Some(op) if op.state == "executing" => return Ok(op.opid),
            Some(Op { opid, txid: Some(txid), .. }) => match self.tx_state(&txid)? {
                Some(TxState::Mined { .. }) => return Ok(opid),
                Some(TxState::Pending) => {
                    let wallet = Arc::clone(self);
                    let id = opid.clone();
                    tokio::spawn(async move { wallet.rebroadcast(&id, &txid).await });
                    return Ok(opid);
                }
                Some(TxState::Expired) => {
                    // Txids stay out of the logs: they outlive a purge and match attendees' wallets.
                    debug!(%txid, "transaction expired unmined; building a replacement");
                    info!("transaction expired unmined; building a replacement");
                    self.ops.restart(&opid)?;
                    opid
                }
                None => bail!("transaction {txid} for this key is unknown to the wallet; refusing to send again"),
            },
            Some(op) => {
                self.ops.restart(&op.opid)?;
                op.opid
            }
        };
        let wallet = Arc::clone(self);
        let (id, account) = (opid.clone(), account.to_string());
        tokio::spawn(async move {
            match wallet.build_and_broadcast(&id, &account, kind).await {
                Ok(txid) => {
                    debug!(%txid, "broadcast");
                    let _ = wallet.ops.finish(&id, "success", "");
                }
                Err(e) => {
                    warn!(error = %e, "send failed");
                    let _ = wallet.ops.finish(&id, "failed", &e.to_string());
                }
            }
        });
        Ok(opid)
    }

    async fn rebroadcast(&self, opid: &str, txid: &str) {
        let result = async {
            let id = TxId::from_hex(txid).ok_or_else(|| anyhow!("bad txid"))?;
            let tx = self.reader()?.get_transaction(id)?.ok_or_else(|| anyhow!("transaction not found"))?;
            let mut raw = RawTransaction::default();
            tx.write(&mut raw.data)?;
            self.broadcast(raw).await
        }
        .await;
        match result {
            Ok(()) => {
                let _ = self.ops.finish(opid, "success", "");
            }
            Err(e) => {
                debug!(%txid, "rebroadcast failed");
                warn!(error = %e, "rebroadcast failed")
            }
        }
    }

    async fn broadcast(&self, raw: RawTransaction) -> anyhow::Result<()> {
        let mut client = self.client().await?;
        let resp = client.send_transaction(raw).await?.into_inner();
        let msg = resp.error_message.to_lowercase();
        // Already known to the node: that is what a rebroadcast hopes for.
        if resp.error_code != 0 && !msg.contains("already") && !msg.contains("txn-mempool-conflict") {
            bail!("lightwalletd rejected the transaction ({}): {}", resp.error_code, resp.error_message);
        }
        Ok(())
    }

    /// Resolve a recipient to the receiver we will actually pay. Under
    /// FullPrivacy only an Orchard receiver is acceptable, so funds never
    /// leave the Orchard pool and no amount is revealed.
    fn shielded_target(&self, address: &str, policy: PrivacyPolicy) -> anyhow::Result<ZcashAddress> {
        let decoded = Address::decode(&self.params, address).ok_or_else(|| anyhow!("Invalid address {address}"))?;
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

    async fn build_and_broadcast(&self, opid: &str, account: &str, kind: SendKind) -> anyhow::Result<String> {
        let uuid = Self::parse_account(account)?;
        let seed = self.seeds.load(account)?;
        let usk = UnifiedSpendingKey::from_seed(&self.params, seed.expose_secret(), zip32::AccountId::ZERO)
            .map_err(|e| anyhow!("key derivation failed: {e:?}"))?;
        let (txid, amount, raw) = {
            let mut db = self.db.lock().await;
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
                    &[ShieldedPool::Orchard],
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
        self.ops.set_built(opid, &txid.to_string(), amount)?;
        self.broadcast(raw).await?;
        Ok(txid.to_string())
    }

    pub fn parse_ua_receivers(&self, address: &str) -> anyhow::Result<serde_json::Value> {
        let decoded = Address::decode(&self.params, address).ok_or_else(|| anyhow!("Invalid address"))?;
        let Address::Unified(ua) = decoded else { bail!("not a unified address") };
        let mut out = serde_json::Map::new();
        if let Some(o) = ua.orchard() {
            let only = UnifiedAddress::from_receivers(Some(*o), None, None).unwrap();
            out.insert("orchard".into(), only.encode(&self.params).into());
        }
        if let Some(s) = ua.sapling() {
            out.insert("sapling".into(), Address::from(*s).encode(&self.params).into());
        }
        if let Some(t) = ua.transparent() {
            out.insert("p2pkh".into(), Address::from(*t).encode(&self.params).into());
        }
        Ok(out.into())
    }

    pub fn network_name(&self) -> &'static str {
        match self.params.network_type() {
            zcash_protocol::consensus::NetworkType::Main => "main",
            zcash_protocol::consensus::NetworkType::Test => "test",
            zcash_protocol::consensus::NetworkType::Regtest => "regtest",
        }
    }
}

impl Wallet {
    pub fn confirmations(&self, mined: Option<u32>) -> u32 {
        match mined {
            Some(h) if self.tip() >= h => self.tip() - h + 1,
            _ => 0,
        }
    }
}
