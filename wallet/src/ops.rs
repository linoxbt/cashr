//! Send operations, kept on disk so that a restart never forgets a payout.
//!
//! Each operation belongs to a caller-chosen idempotency key. The txid is
//! recorded as soon as the transaction is built and *before* it is broadcast,
//! so after any crash the wallet knows whether a transaction for a key may be
//! on its way to the chain.

use std::{path::Path, sync::Mutex};

use anyhow::bail;
use rusqlite::{params, Connection, OptionalExtension};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Op {
    pub opid: String,
    pub key: String,
    pub account: String,
    /// "executing" | "success" | "failed"
    pub state: String,
    pub txid: Option<String>,
    pub error: String,
    pub amount: Option<u64>,
}

pub struct OpStore {
    conn: Mutex<Connection>,
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

impl OpStore {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA secure_delete = ON;
             CREATE TABLE IF NOT EXISTS ops (
                 opid TEXT PRIMARY KEY,
                 key TEXT NOT NULL UNIQUE,
                 account TEXT NOT NULL,
                 state TEXT NOT NULL,
                 txid TEXT,
                 error TEXT NOT NULL DEFAULT '',
                 amount INTEGER,
                 updated INTEGER NOT NULL
             );",
        )?;
        // A build interrupted by a restart either never produced a transaction
        // (safe to retry) or recorded its txid first (track that transaction).
        conn.execute(
            "UPDATE ops SET state = 'failed', error = 'interrupted by a restart before anything was broadcast'
             WHERE state = 'executing' AND txid IS NULL",
            [],
        )?;
        conn.execute("UPDATE ops SET state = 'success' WHERE state = 'executing' AND txid IS NOT NULL", [])?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn row(r: &rusqlite::Row) -> rusqlite::Result<Op> {
        Ok(Op {
            opid: r.get(0)?,
            key: r.get(1)?,
            account: r.get(2)?,
            state: r.get(3)?,
            txid: r.get(4)?,
            error: r.get(5)?,
            amount: r.get::<_, Option<i64>>(6)?.map(|a| a as u64),
        })
    }

    const COLS: &'static str = "opid, key, account, state, txid, error, amount";

    pub fn get(&self, opid: &str) -> anyhow::Result<Option<Op>> {
        let c = self.conn.lock().unwrap();
        Ok(c.query_row(&format!("SELECT {} FROM ops WHERE opid = ?1", Self::COLS), [opid], Self::row).optional()?)
    }

    pub fn by_key(&self, key: &str) -> anyhow::Result<Option<Op>> {
        let c = self.conn.lock().unwrap();
        Ok(c.query_row(&format!("SELECT {} FROM ops WHERE key = ?1", Self::COLS), [key], Self::row).optional()?)
    }

    pub fn insert(&self, opid: &str, key: &str, account: &str) -> anyhow::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO ops (opid, key, account, state, updated) VALUES (?1, ?2, ?3, 'executing', ?4)",
            params![opid, key, account, now()],
        )?;
        Ok(())
    }

    /// Start a fresh build for an existing operation (its previous attempt
    /// failed before broadcast, or its transaction expired unmined).
    pub fn restart(&self, opid: &str) -> anyhow::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE ops SET state = 'executing', txid = NULL, error = '', amount = NULL, updated = ?2 WHERE opid = ?1",
            params![opid, now()],
        )?;
        Ok(())
    }

    pub fn set_built(&self, opid: &str, txid: &str, amount: u64) -> anyhow::Result<()> {
        let c = self.conn.lock().unwrap();
        let n = c.execute(
            "UPDATE ops SET txid = ?2, amount = ?3, updated = ?4 WHERE opid = ?1",
            params![opid, txid, amount as i64, now()],
        )?;
        if n != 1 {
            bail!("operation {opid} vanished");
        }
        Ok(())
    }

    pub fn finish(&self, opid: &str, state: &str, error: &str) -> anyhow::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute("UPDATE ops SET state = ?2, error = ?3, updated = ?4 WHERE opid = ?1", params![opid, state, error, now()])?;
        Ok(())
    }

    pub fn delete_account(&self, account: &str) -> anyhow::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM ops WHERE account = ?1", [account])?;
        Ok(())
    }

    /// Forget settled operations after `days`; the API stops asking long before.
    pub fn prune(&self, days: i64) -> anyhow::Result<usize> {
        let c = self.conn.lock().unwrap();
        Ok(c.execute("DELETE FROM ops WHERE state != 'executing' AND updated < ?1", [now() - days * 86_400])?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_keeps_what_may_be_on_chain() {
        let path = std::env::temp_dir().join(format!("uw-ops-{}.sqlite", uuid::Uuid::new_v4()));
        let store = OpStore::open(&path).unwrap();
        store.insert("op-a", "key-a", "acct").unwrap();
        store.insert("op-b", "key-b", "acct").unwrap();
        store.set_built("op-b", "txid-b", 5).unwrap();
        drop(store);
        // Both were mid-flight when the process died.
        let store = OpStore::open(&path).unwrap();
        let a = store.by_key("key-a").unwrap().unwrap();
        assert_eq!((a.state.as_str(), a.txid), ("failed", None));
        let b = store.get("op-b").unwrap().unwrap();
        assert_eq!((b.state.as_str(), b.txid.as_deref(), b.amount), ("success", Some("txid-b"), Some(5)));
        assert!(store.insert("op-c", "key-a", "acct").is_err(), "keys are unique");
        store.delete_account("acct").unwrap();
        assert!(store.get("op-b").unwrap().is_none());
        let secure: i64 = store.conn.lock().unwrap().query_row("PRAGMA secure_delete", [], |r| r.get(0)).unwrap();
        assert_eq!(secure, 1, "deleted rows are overwritten");
        let _ = std::fs::remove_file(path);
    }
}
