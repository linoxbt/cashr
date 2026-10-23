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
                 updated INTEGER NOT NULL,
                 attempt INTEGER NOT NULL DEFAULT 0
             );",
        )?;
        // Accounts this wallet deleted, so "no such account" can be told apart from a
        // wallet database that was reset or restored (whose seeds must be kept).
        // And whether a delete still owes the file rewrite that clears its traces.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS deleted_accounts (account TEXT PRIMARY KEY, at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS flags (name TEXT PRIMARY KEY);",
        )?;
        let has_attempt = conn
            .prepare("SELECT 1 FROM pragma_table_info('ops') WHERE name = 'attempt'")?
            .exists([])?;
        if !has_attempt {
            conn.execute_batch("ALTER TABLE ops ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;")?;
        }
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
    /// failed before broadcast, or its transaction expired unmined). Returns
    /// the new attempt number: only that attempt may record a txid or an
    /// outcome, so a build or rebroadcast left over from an earlier attempt
    /// can never overwrite this one.
    pub fn restart(&self, opid: &str) -> anyhow::Result<i64> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE ops SET state = 'executing', txid = NULL, error = '', amount = NULL, updated = ?2,
                 attempt = attempt + 1 WHERE opid = ?1",
            params![opid, now()],
        )?;
        Ok(c.query_row("SELECT attempt FROM ops WHERE opid = ?1", [opid], |r| r.get(0))?)
    }

    /// Record the txid a build produced. Refused unless `attempt` is still the
    /// operation's current, executing attempt: the caller must then not broadcast.
    pub fn set_built(&self, opid: &str, attempt: i64, txid: &str, amount: u64) -> anyhow::Result<()> {
        let c = self.conn.lock().unwrap();
        let n = c.execute(
            "UPDATE ops SET txid = ?3, amount = ?4, updated = ?5
             WHERE opid = ?1 AND attempt = ?2 AND state = 'executing' AND txid IS NULL",
            params![opid, attempt, txid, amount as i64, now()],
        )?;
        if n != 1 {
            bail!("operation {opid} attempt {attempt} is no longer current; not broadcasting");
        }
        Ok(())
    }

    /// Record how an attempt ended. A finished or superseded attempt is left alone.
    pub fn finish(&self, opid: &str, attempt: i64, state: &str, error: &str) -> anyhow::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE ops SET state = ?3, error = ?4, updated = ?5 WHERE opid = ?1 AND attempt = ?2 AND state = 'executing'",
            params![opid, attempt, state, error, now()],
        )?;
        Ok(())
    }

    /// Every operation of an account, for checks before deleting it.
    pub fn for_account(&self, account: &str) -> anyhow::Result<Vec<Op>> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare(&format!("SELECT {} FROM ops WHERE account = ?1", Self::COLS))?;
        let rows = stmt.query_map([account], Self::row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn delete_account(&self, account: &str) -> anyhow::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM ops WHERE account = ?1", [account])?;
        // secure_delete scrubs the database pages, not the WAL's old frames, which
        // would keep the deleted payouts' txids (and so the attendees they paid).
        c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    }

    /// Record that an account is being deleted. Written before the delete, so it
    /// is there for any retry.
    pub fn mark_deleted(&self, account: &str) -> anyhow::Result<()> {
        let c = self.conn.lock().unwrap();
        // No time: it would date the event's purge.
        c.execute("INSERT OR IGNORE INTO deleted_accounts (account, at) VALUES (?1, 0)", params![account])?;
        Ok(())
    }

    pub fn was_deleted(&self, account: &str) -> anyhow::Result<bool> {
        let c = self.conn.lock().unwrap();
        let found = c.prepare("SELECT 1 FROM deleted_accounts WHERE account = ?1")?.exists([account])?;
        Ok(found)
    }

    pub fn set_flag(&self, name: &str, on: bool) -> anyhow::Result<()> {
        let c = self.conn.lock().unwrap();
        if on {
            c.execute("INSERT OR IGNORE INTO flags (name) VALUES (?1)", [name])?;
        } else {
            c.execute("DELETE FROM flags WHERE name = ?1", [name])?;
        }
        Ok(())
    }

    pub fn flag(&self, name: &str) -> anyhow::Result<bool> {
        let c = self.conn.lock().unwrap();
        let found = c.prepare("SELECT 1 FROM flags WHERE name = ?1")?.exists([name])?;
        Ok(found)
    }

    /// Forget settled operations after `days`; the API stops asking long before.
    pub fn prune(&self, days: i64) -> anyhow::Result<usize> {
        let c = self.conn.lock().unwrap();
        // Only operations that never produced a transaction: a key with a txid is
        // kept for as long as its account, or resubmitting it after the prune would
        // build a second transaction while the first could still be mined.
        Ok(c.execute(
            "DELETE FROM ops WHERE state = 'failed' AND txid IS NULL AND updated < ?1",
            [now() - days * 86_400],
        )?)
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
        store.set_built("op-b", 0, "txid-b", 5).unwrap();
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

    #[test]
    fn a_superseded_attempt_records_nothing() {
        let path = std::env::temp_dir().join(format!("uw-ops-{}.sqlite", uuid::Uuid::new_v4()));
        let store = OpStore::open(&path).unwrap();
        store.insert("op", "key", "acct").unwrap();
        store.finish("op", 0, "failed", "build failed").unwrap();
        // The API asks again: attempt 1 starts while attempt 0's leftovers still run.
        assert_eq!(store.restart("op").unwrap(), 1);
        assert!(store.set_built("op", 0, "stale-tx", 5).is_err(), "attempt 0 may not record a txid");
        store.finish("op", 0, "success", "").unwrap();
        assert_eq!(store.get("op").unwrap().unwrap().state, "executing", "attempt 0 may not finish attempt 1");
        store.set_built("op", 1, "tx-1", 5).unwrap();
        assert!(store.set_built("op", 1, "tx-again", 5).is_err(), "one txid per attempt");
        store.finish("op", 1, "success", "").unwrap();
        let op = store.get("op").unwrap().unwrap();
        assert_eq!((op.state.as_str(), op.txid.as_deref()), ("success", Some("tx-1")));
        assert_eq!(store.for_account("acct").unwrap().len(), 1);
        // Tombstones and flags survive the account's operations being deleted, and a reopen.
        store.mark_deleted("acct").unwrap();
        store.delete_account("acct").unwrap();
        store.set_flag("compact", true).unwrap();
        drop(store);
        let store = OpStore::open(&path).unwrap();
        assert!(store.was_deleted("acct").unwrap() && !store.was_deleted("other").unwrap());
        assert!(store.flag("compact").unwrap());
        store.set_flag("compact", false).unwrap();
        assert!(!store.flag("compact").unwrap());
        let _ = std::fs::remove_file(path);
    }
}
