#!/usr/bin/env bash
# Encrypted backup of the cashr data volumes, run nightly by /etc/cron.d/cashr-backup
# (deploy/install.sh sets it up). Run it by hand any time: deploy/backup.sh
#
# Each backup holds the wallet volume (encrypted seeds, wallet and payout state) and the
# API's database, taken as consistent SQLite snapshots while the services keep running.
# It is built in memory and encrypted with CASHR_BACKUP_PASSPHRASE from .env before it
# touches the disk. Spending still needs CASHR_WALLET_SEED_KEY, which is NOT in the
# backup: keep both of them somewhere offline, apart from the backups.
#
# The last $KEEP backups stay in $CASHR_BACKUP_DIR (default /var/backups/cashr). Set
# CASHR_BACKUP_REMOTE in .env (an rsync target such as user@host:/srv/cashr-backups) to
# copy each one off this machine too; a backup on the same disk doesn't survive it.
#
# Privacy: a backup keeps events that are purged after it was taken, until it is rotated
# out ($KEEP days). Restore: see docs/DEPLOY.md.
set -euo pipefail

DIR="${CASHR_DIR:-/opt/cashr}"
KEEP="${CASHR_BACKUP_KEEP:-7}"
env_get() { grep -E "^$1=" "$DIR/.env" | tail -1 | cut -d= -f2- || true; }

PASS="$(env_get CASHR_BACKUP_PASSPHRASE)"
[ -n "$PASS" ] || { echo "Set CASHR_BACKUP_PASSPHRASE in $DIR/.env (openssl rand -hex 32)." >&2; exit 1; }
OUT="${CASHR_BACKUP_DIR:-$(env_get CASHR_BACKUP_DIR)}"
OUT="${OUT:-/var/backups/cashr}"
REMOTE="$(env_get CASHR_BACKUP_REMOTE)"
IMAGE="ghcr.io/linoxbt/cashr-api:$(env_get CASHR_TAG)"
[ "$IMAGE" != "ghcr.io/linoxbt/cashr-api:" ] || IMAGE="ghcr.io/linoxbt/cashr-api:main"

umask 077
mkdir -p "$OUT"
file="$OUT/cashr-$(date -u +%Y%m%dT%H%M%SZ).tgz.enc"

# Snapshots go to a memory-only directory inside a throwaway container, and leave it
# only as a tar stream that is encrypted on the way to disk.
docker run --rm --user 0 --network none --tmpfs /out:size=512m \
  -v cashr_wallet-data:/volumes/wallet-data -v cashr_api-data:/volumes/api-data \
  --entrypoint python "$IMAGE" -c '
import os, shutil, sqlite3, sys, tarfile
for vol in ("wallet-data", "api-data"):
    src_root, dst_root = f"/volumes/{vol}", f"/out/{vol}"
    for root, _dirs, files in os.walk(src_root):
        dst = os.path.join(dst_root, os.path.relpath(root, src_root))
        os.makedirs(dst, exist_ok=True)
        for name in files:
            src = os.path.join(root, name)
            if name.endswith(("-wal", "-shm", "-journal", ".lock")):
                continue  # folded into the snapshot below
            if name.endswith((".sqlite", ".db")):
                # The online backup API: a consistent copy while the service writes.
                with sqlite3.connect(src, timeout=60) as a, sqlite3.connect(os.path.join(dst, name)) as b:
                    a.backup(b)
            else:
                shutil.copy2(src, os.path.join(dst, name))
with tarfile.open(fileobj=sys.stdout.buffer, mode="w|gz") as tar:
    tar.add("/out", arcname=".")
' | PASS="$PASS" openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:PASS -out "$file.part"
mv "$file.part" "$file"
echo "$(date -u +%FT%TZ) wrote $file ($(du -h "$file" | cut -f1))"

# Rotate: keep the newest $KEEP.
ls -1t "$OUT"/cashr-*.tgz.enc 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f --

if [ -n "$REMOTE" ]; then
  rsync -a --delete --include 'cashr-*.tgz.enc' --exclude '*' "$OUT"/ "$REMOTE"/ \
    && echo "copied to $REMOTE" || { echo "copy to $REMOTE failed" >&2; exit 1; }
fi
