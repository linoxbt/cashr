//! Per-event seeds, encrypted at rest.
//!
//! Every event account is derived from its own random seed rather than from one
//! wallet-wide seed. Purging an event deletes its seed, after which nobody,
//! including whoever holds this server, can derive the keys that decrypt that
//! event's memos from the chain again. Seeds are encrypted with
//! ChaCha20-Poly1305 under `UW_SEED_KEY`, so a copy of the data volume alone
//! cannot spend anything. It is still private data: `wallet.sqlite` keeps each
//! live event's viewing key and its decrypted memos (ticket hashes and refund
//! addresses) until the event is purged.

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, bail, Context};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Key, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use secrecy::{ExposeSecret, SecretVec};

const AAD: &[u8] = b"unlisted-wallet seed v1";

pub struct SeedStore {
    dir: PathBuf,
    cipher: ChaCha20Poly1305,
}

impl SeedStore {
    /// `key_hex` is 64 hex characters (32 bytes).
    pub fn open(dir: &Path, key_hex: &str) -> anyhow::Result<Self> {
        let key = hex::decode(key_hex.trim()).context("UW_SEED_KEY must be hex")?;
        if key.len() != 32 {
            bail!("UW_SEED_KEY must be 32 bytes (64 hex characters)");
        }
        fs::create_dir_all(dir)?;
        Ok(Self { dir: dir.to_path_buf(), cipher: ChaCha20Poly1305::new(Key::from_slice(&key)) })
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.seed"))
    }

    pub fn generate() -> SecretVec<u8> {
        let mut seed = vec![0u8; 32];
        OsRng.fill_bytes(&mut seed);
        SecretVec::new(seed)
    }

    /// Write a seed under a temporary name; `commit` renames it once the account exists.
    pub fn stage(&self, seed: &SecretVec<u8>) -> anyhow::Result<String> {
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let ct = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: seed.expose_secret(), aad: AAD })
            .map_err(|_| anyhow!("seed encryption failed"))?;
        let name = format!("staged-{}", uuid::Uuid::new_v4());
        let mut data = nonce.to_vec();
        data.extend_from_slice(&ct);
        write_private(&self.path(&name), &data)?;
        Ok(name)
    }

    pub fn commit(&self, staged: &str, account: &str) -> anyhow::Result<()> {
        fs::rename(self.path(staged), self.path(account))?;
        // The rename only survives a power cut once the directory is synced. The
        // account already exists, so failing here would orphan it: best effort,
        // and a lost rename is repaired at startup (Wallet::open).
        let _ = fs::File::open(&self.dir).and_then(|d| d.sync_all());
        Ok(())
    }

    /// Seeds staged by a create that never finished (the process died between
    /// staging and committing).
    pub fn staged(&self) -> anyhow::Result<Vec<String>> {
        let mut out = vec![];
        for entry in fs::read_dir(&self.dir)? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            if let Some(stem) = name.strip_suffix(".seed") {
                if stem.starts_with("staged-") {
                    out.push(stem.to_string());
                }
            }
        }
        Ok(out)
    }

    /// Keep a damaged staged seed out of the way, without destroying it.
    pub fn quarantine(&self, staged: &str) -> anyhow::Result<()> {
        let to = self.dir.join(format!("{staged}.unreadable"));
        fs::rename(self.path(staged), to)?;
        Ok(())
    }

    pub fn discard(&self, staged: &str) {
        let _ = fs::remove_file(self.path(staged));
    }

    pub fn load(&self, account: &str) -> anyhow::Result<SecretVec<u8>> {
        let data = fs::read(self.path(account)).with_context(|| format!("no seed for account {account}"))?;
        if data.len() < 12 {
            bail!("seed file for {account} is damaged");
        }
        let (nonce, ct) = data.split_at(12);
        let seed = self
            .cipher
            .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: AAD })
            .map_err(|_| anyhow!("cannot decrypt the seed for {account}: wrong UW_SEED_KEY?"))?;
        Ok(SecretVec::new(seed))
    }

    pub fn delete(&self, account: &str) -> anyhow::Result<()> {
        let path = self.path(account);
        if let Ok(len) = fs::metadata(&path).map(|m| m.len()) {
            // Overwrite in place (no truncation, which would just free the old
            // blocks) before unlinking. Best effort: a journaling or copy-on-write
            // filesystem may keep old copies, which is why seeds are encrypted.
            use std::io::Write;
            if let Ok(mut f) = fs::OpenOptions::new().write(true).open(&path) {
                let _ = f.write_all(&vec![0u8; len as usize]).and_then(|_| f.sync_all());
            }
        }
        match fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}

pub fn write_private(path: &Path, data: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let mut f = opts.open(path)?;
    f.write_all(data)?;
    f.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_round_trip_and_are_encrypted() {
        let dir = std::env::temp_dir().join(format!("uw-seeds-{}", uuid::Uuid::new_v4()));
        let store = SeedStore::open(&dir, &"11".repeat(32)).unwrap();
        let seed = SeedStore::generate();
        let staged = store.stage(&seed).unwrap();
        store.commit(&staged, "acct").unwrap();
        let raw = fs::read(dir.join("acct.seed")).unwrap();
        assert!(!raw.windows(32).any(|w| w == seed.expose_secret().as_slice()));
        assert_eq!(store.load("acct").unwrap().expose_secret(), seed.expose_secret());
        let wrong = SeedStore::open(&dir, &"22".repeat(32)).unwrap();
        assert!(wrong.load("acct").is_err());
        store.delete("acct").unwrap();
        assert!(store.load("acct").is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
