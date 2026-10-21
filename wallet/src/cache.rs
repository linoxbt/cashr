//! In-memory compact block cache used by the sync loop.
//!
//! Blocks are downloaded, scanned and deleted range by range, so the cache only
//! ever holds one batch. Nothing here needs to survive a restart.

use std::{
    collections::BTreeMap,
    convert::Infallible,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use zcash_client_backend::{
    data_api::{
        chain::{error, BlockCache, BlockSource},
        scanning::ScanRange,
    },
    proto::compact_formats::CompactBlock,
};
use zcash_protocol::consensus::BlockHeight;

#[derive(Clone, Default)]
pub struct MemBlockCache(Arc<Mutex<BTreeMap<u32, CompactBlock>>>);

fn height_of(block: &CompactBlock) -> u32 {
    block.height as u32
}

impl BlockSource for MemBlockCache {
    type Error = Infallible;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), error::Error<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), error::Error<WalletErrT, Self::Error>>,
    {
        // Copy out before calling back, so the callback never runs under the lock.
        let blocks: Vec<CompactBlock> = {
            let cache = self.0.lock().unwrap();
            let start = from_height.map(u32::from).unwrap_or(0);
            cache
                .range(start..)
                .take(limit.unwrap_or(usize::MAX))
                .map(|(_, b)| b.clone())
                .collect()
        };
        for block in blocks {
            with_block(block)?;
        }
        Ok(())
    }
}

#[async_trait]
impl BlockCache for MemBlockCache {
    fn get_tip_height(&self, range: Option<&ScanRange>) -> Result<Option<BlockHeight>, Self::Error> {
        let cache = self.0.lock().unwrap();
        let tip = match range {
            Some(r) => cache
                .range(u32::from(r.block_range().start)..u32::from(r.block_range().end))
                .next_back()
                .map(|(h, _)| *h),
            None => cache.keys().next_back().copied(),
        };
        Ok(tip.map(BlockHeight::from_u32))
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let cache = self.0.lock().unwrap();
        Ok(cache
            .range(u32::from(range.block_range().start)..u32::from(range.block_range().end))
            .map(|(_, b)| b.clone())
            .collect())
    }

    async fn insert(&self, compact_blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        let mut cache = self.0.lock().unwrap();
        for block in compact_blocks {
            cache.insert(height_of(&block), block);
        }
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        let mut cache = self.0.lock().unwrap();
        let doomed: Vec<u32> = cache
            .range(u32::from(range.block_range().start)..u32::from(range.block_range().end))
            .map(|(h, _)| *h)
            .collect();
        for h in doomed {
            cache.remove(&h);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_client_backend::data_api::scanning::ScanPriority;

    fn block(h: u64) -> CompactBlock {
        CompactBlock { height: h, ..Default::default() }
    }

    #[tokio::test]
    async fn stores_reads_and_deletes_ranges() {
        let cache = MemBlockCache::default();
        cache.insert((10..20).map(block).collect()).await.unwrap();
        let range = ScanRange::from_parts(BlockHeight::from_u32(12)..BlockHeight::from_u32(15), ScanPriority::Historic);
        let got: Vec<u64> = cache.read(&range).await.unwrap().iter().map(|b| b.height).collect();
        assert_eq!(got, vec![12, 13, 14]);
        assert_eq!(cache.get_tip_height(Some(&range)).unwrap(), Some(BlockHeight::from_u32(14)));
        assert_eq!(cache.get_tip_height(None).unwrap(), Some(BlockHeight::from_u32(19)));

        let mut seen = vec![];
        cache
            .with_blocks::<_, ()>(Some(BlockHeight::from_u32(17)), Some(2), |b| {
                seen.push(b.height);
                Ok(())
            })
            .unwrap();
        assert_eq!(seen, vec![17, 18]);

        cache.delete(range).await.unwrap();
        assert_eq!(cache.read(&ScanRange::from_parts(BlockHeight::from_u32(0)..BlockHeight::from_u32(100), ScanPriority::Historic)).await.unwrap().len(), 7);
    }
}
