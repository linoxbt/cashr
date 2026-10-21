//! The wallet: one seed, one ZIP 32 account per Unlisted event.

use std::{
    collections::{BTreeSet, HashMap},
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
};

use anyhow::{anyhow, bail, Context};
use rand::rngs::OsRng;
use secrecy::{ExposeSecret, SecretVec};
use tokio::sync::Mutex;
use tonic::Code;
use tracing::{info, warn};
use zcash_address::ZcashAddress;
use zcash_client_backend::{
    data_api::{
        wallet::{
            create_proposed_transactions, decrypt_and_store_transaction,
            input_selection::{GreedyInputSelector, SpendPolicy},
            propose_transfer, ConfirmationsPolicy, SpendingKeys,
        },
        Account as _, AccountBirthday, TransactionDataRequest, TransactionStatus, WalletRead,
        WalletWrite,
    },
    fees::{zip317::SingleOutputChangeStrategy, DustOutputPolicy, StandardFeeRule},
    proto::service::{BlockId, ChainSpec, RawTransaction, TxFilter},
    wallet::OvkPolicy,
};
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
    lightwalletd::{Client, Endpoint},
};

pub type Db = WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>;

#[derive(Clone, Debug)]
pub enum OpState {
    Executing,
    Success(String),
    Failed(String),
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
    db: Mutex<Db>,
    db_path: PathBuf,
    seed: SecretVec<u8>,
    cache: MemBlockCache,
    endpoint: Endpoint,
    client: Mutex<Option<Client>>,
    ops: std::sync::Mutex<HashMap<String, OpState>>,
    tip: AtomicU32,
    scanned: AtomicU32,
    prover: LocalTxProver,
}

impl Wallet {
    pub fn open(params: Network, db_path: PathBuf, seed: SecretVec<u8>, endpoint: Endpoint) -> anyhow::Result<Arc<Self>> {
        let mut db = WalletDb::for_path(&db_path, params, SystemClock, OsRng)?;
        zcash_client_sqlite::wallet::init::init_wallet_db(&mut db, Some(SecretVec::new(seed.expose_secret().clone())))
            .map_err(|e| anyhow!("wallet database migration failed: {e:?}"))?;
        let tip = db.chain_height()?.map(u32::from).unwrap_or(0);
        Ok(Arc::new(Self {
            params,
            db: Mutex::new(db),
            db_path,
            seed,
            cache: MemBlockCache::default(),
            endpoint,
            client: Mutex::new(None),
            ops: Default::default(),
            tip: AtomicU32::new(tip),
            scanned: AtomicU32::new(0),
            prover: LocalTxProver::bundled(),
        }))
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
                        let status = match self.fetch_tx(client, tip, *txid).await? {
                            None => TransactionStatus::TxidNotRecognized,
                            Some((_, Some(h))) => TransactionStatus::Mined(h),
                            Some((_, None)) => TransactionStatus::NotInMainChain,
                        };
                        db.set_transaction_status(*txid, status)?;
                    }
                    TransactionDataRequest::Enhancement(txid) => match self.fetch_tx(client, tip, *txid).await? {
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

    /// Create a fresh account whose birthday is the current tip, so it never
    /// scans history. Returns its ZIP 32 account index.
    pub async fn new_account(&self) -> anyhow::Result<u32> {
        let mut client = self.client().await?;
        let latest = client.get_latest_block(ChainSpec::default()).await?.into_inner();
        let treestate = client
            .get_tree_state(BlockId { height: latest.height.saturating_sub(1), ..Default::default() })
            .await?
            .into_inner();
        let birthday = AccountBirthday::from_treestate(treestate, None)
            .map_err(|e| anyhow!("bad tree state from lightwalletd: {e:?}"))?;
        let mut db = self.db.lock().await;
        let name = format!("unlisted-{}", db.get_account_ids()?.len());
        let (uuid, _) = db.create_account(&name, &self.seed, &birthday, None)?;
        let index = Self::index_of(&db, uuid)?;
        info!(account = index, birthday = latest.height, "created account");
        Ok(index)
    }

    fn index_of(db: &Db, uuid: AccountUuid) -> anyhow::Result<u32> {
        let account = db.get_account(uuid)?.ok_or_else(|| anyhow!("account vanished"))?;
        let derivation = account
            .source()
            .key_derivation()
            .ok_or_else(|| anyhow!("account is not derived from the wallet seed"))?;
        Ok(u32::from(derivation.account_index()))
    }

    fn uuid_of(db: &Db, index: u32) -> anyhow::Result<AccountUuid> {
        for id in db.get_account_ids()? {
            if Self::index_of(db, id).ok() == Some(index) {
                return Ok(id);
            }
        }
        bail!("no account with index {index}")
    }

    pub async fn address_for(&self, index: u32, orchard: bool, sapling: bool) -> anyhow::Result<String> {
        let req = |on: bool| if on { ReceiverRequirement::Require } else { ReceiverRequirement::Omit };
        let request = UnifiedAddressRequest::Custom(
            ReceiverRequirements::new(req(orchard), req(sapling), ReceiverRequirement::Omit)
                .map_err(|_| anyhow!("a unified address needs a shielded receiver"))?,
        );
        let mut db = self.db.lock().await;
        let uuid = Self::uuid_of(&db, index)?;
        let (ua, _) = db
            .get_next_available_address(uuid, request)?
            .ok_or_else(|| anyhow!("no address available"))?;
        Ok(ua.encode(&self.params))
    }

    pub async fn spendable(&self, index: u32) -> anyhow::Result<(u64, u64)> {
        let db = self.db.lock().await;
        let uuid = Self::uuid_of(&db, index)?;
        let Some(summary) = db.get_wallet_summary(ConfirmationsPolicy::default())? else {
            return Ok((0, 0));
        };
        Ok(summary
            .account_balances()
            .get(&uuid)
            .map(|b| {
                (
                    b.orchard_balance().spendable_value().into_u64(),
                    b.sapling_balance().spendable_value().into_u64(),
                )
            })
            .unwrap_or((0, 0)))
    }

    /// Every non-change output received at `address` whose memo is known.
    /// Outputs found by compact scanning wait here until their full
    /// transaction has been fetched, so a caller never sees a memo-less note.
    pub fn received_at(&self, address: &str) -> anyhow::Result<Vec<ReceivedOutput>> {
        let conn = rusqlite::Connection::open_with_flags(&self.db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut stmt = conn.prepare(
            "SELECT t.txid, t.mined_height, ro.pool, ro.output_index, ro.value, ro.memo
             FROM v_received_outputs ro
             JOIN transactions t ON t.id_tx = ro.transaction_id
             JOIN addresses a ON a.id = ro.address_id
             WHERE a.address = ?1 AND ro.is_change = 0 AND ro.memo IS NOT NULL",
        )?;
        let rows = stmt.query_map([address], |row| {
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

    pub async fn account_for_address(&self, address: &str) -> anyhow::Result<u32> {
        let conn = rusqlite::Connection::open_with_flags(&self.db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let uuid: Vec<u8> = conn
            .query_row(
                "SELECT acc.uuid FROM addresses ad JOIN accounts acc ON acc.id = ad.account_id WHERE ad.address = ?1",
                [address],
                |r| r.get(0),
            )
            .context("from address does not belong to this wallet")?;
        let uuid = uuid::Uuid::from_slice(&uuid)?;
        let db = self.db.lock().await;
        Self::index_of(&db, AccountUuid::from_uuid(uuid))
    }

    // ---- sending ------------------------------------------------------------

    pub fn op_status(&self, opid: &str) -> Option<OpState> {
        self.ops.lock().unwrap().get(opid).cloned()
    }

    /// Validate synchronously, then build, prove and broadcast in the background.
    pub fn send(self: &Arc<Self>, from_index: u32, recipients: Vec<Recipient>, policy: PrivacyPolicy) -> anyhow::Result<String> {
        let mut payments = Vec::with_capacity(recipients.len());
        for r in &recipients {
            payments.push(Payment::new(self.shielded_target(&r.address, policy)?, Some(r.amount), Some(r.memo.clone()), None, None, vec![])
                .map_err(|e| anyhow!("invalid payment: {e:?}"))?);
        }
        let request = TransactionRequest::new(payments).map_err(|e| anyhow!("invalid request: {e:?}"))?;
        let opid = format!("opid-{}", uuid::Uuid::new_v4());
        self.ops.lock().unwrap().insert(opid.clone(), OpState::Executing);
        let wallet = Arc::clone(self);
        let id = opid.clone();
        tokio::spawn(async move {
            let state = match wallet.send_inner(from_index, request).await {
                Ok(txid) => {
                    info!(%txid, "broadcast");
                    OpState::Success(txid)
                }
                Err(e) => {
                    warn!(error = %e, "send failed");
                    OpState::Failed(e.to_string())
                }
            };
            wallet.ops.lock().unwrap().insert(id, state);
        });
        Ok(opid)
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

    async fn send_inner(&self, from_index: u32, request: TransactionRequest) -> anyhow::Result<String> {
        let raw = {
            let mut db = self.db.lock().await;
            let uuid = Self::uuid_of(&db, from_index)?;
            let usk = UnifiedSpendingKey::from_seed(
                &self.params,
                self.seed.expose_secret(),
                zip32::AccountId::try_from(from_index).map_err(|_| anyhow!("bad account index"))?,
            )
            .map_err(|e| anyhow!("key derivation failed: {e:?}"))?;
            let change = SingleOutputChangeStrategy::new(
                StandardFeeRule::Zip317,
                None,
                ShieldedPool::Orchard,
                DustOutputPolicy::default(),
            );
            let proposal = propose_transfer::<_, _, _, _, std::convert::Infallible>(
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
            .map_err(|e| anyhow!("{e}"))?;
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
            (tx.txid(), raw)
        };
        let (txid, raw) = raw;
        let mut client = self.client().await?;
        let resp = client.send_transaction(raw).await?.into_inner();
        if resp.error_code != 0 {
            bail!("lightwalletd rejected the transaction ({}): {}", resp.error_code, resp.error_message);
        }
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
