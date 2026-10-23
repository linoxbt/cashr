#!/usr/bin/env bash
# One-command install of the cashr backend (wallet + API + HTTPS) on a fresh
# Ubuntu 22.04/24.04 server. Run as root:
#
#   curl -fsSL https://raw.githubusercontent.com/linoxbt/cashr/main/deploy/install.sh | bash -s -- [api-domain] [web-origin]
#
# api-domain  Hostname whose DNS A record points at this server (e.g. api.example.com).
#             Omit it to use <ip>.sslip.io, which needs no DNS setup.
# web-origin  Where the web app lives (default https://cashr.site).
#
# Re-running it updates to the latest images and restarts the services; secrets and
# settings in .env are kept (a web-origin given again replaces the CORS setting).
#
# CASHR_PROXY=none  Skip the bundled Caddy (ports 80/443) and the firewall changes, for a
#                   server whose own HTTPS proxy forwards to 127.0.0.1:$CASHR_API_PORT.
set -euo pipefail

DOMAIN="${1:-}"
WEB_ORIGIN="${2:-https://cashr.site}"
WEB_ORIGIN_GIVEN="${2:+yes}"
PROXY="${CASHR_PROXY:-caddy}"
ALPINE="alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
REPO="${CASHR_REPO:-https://github.com/linoxbt/cashr.git}"
BRANCH="${CASHR_BRANCH:-main}"
DIR="${CASHR_DIR:-/opt/cashr}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run this as root (sudo -i)." >&2; exit 1; }

say "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl openssl ufw ca-certificates >/dev/null
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi

# Prebuilt images need about 1 GB; the wallet's data grows slowly after that.
free_mb=$(df -Pm /var/lib/docker 2>/dev/null | awk 'NR==2 {print $4}')
[ -n "$free_mb" ] || free_mb=$(df -Pm / | awk 'NR==2 {print $4}')
if [ "$free_mb" -lt 2048 ]; then
  echo "Only ${free_mb} MB of disk is free; cashr needs at least 2 GB. Free some space and re-run." >&2
  echo "Biggest directories:  du -xh / --max-depth=2 2>/dev/null | sort -h | tail -15" >&2
  echo "Unused Docker data:   docker system df   (then e.g. docker builder prune)" >&2
  exit 1
fi

# Installs from before the rename lived in /opt/unlisted: move them, keeping
# their secrets.
if [ ! -e "$DIR" ] && [ -d /opt/unlisted/.git ]; then
  say "Moving the old install from /opt/unlisted to $DIR"
  (cd /opt/unlisted && docker compose -p unlisted --profile https down) || true
  mv /opt/unlisted "$DIR"
fi

say "Fetching cashr ($BRANCH)"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q --depth 1 origin "$BRANCH" && git -C "$DIR" reset -q --hard FETCH_HEAD
else
  git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

if [ -f .env ] && grep -qE '^(UNLISTED_|UW_)' .env; then
  say "Renaming settings to the cashr names"
  cp .env .env.before-rename
  sed -i -E 's/^UW_/CASHR_WALLET_/; s/^UNLISTED_/CASHR_/' .env
  chmod 600 .env .env.before-rename
fi

# Data volumes were named after the old "unlisted" project: copy them once into
# the cashr ones. A marker written last proves a copy finished; without it the
# copy is redone, so an interrupted run can't leave the wallet on partial data.
OLD_VOLUMES=""
for v in wallet-data api-data caddy-data; do
  docker volume inspect "unlisted_$v" >/dev/null 2>&1 || continue
  OLD_VOLUMES="$OLD_VOLUMES unlisted_$v"
  if docker volume inspect "cashr_$v" >/dev/null 2>&1 &&
     docker run --rm -v "cashr_$v:/to:ro" "$ALPINE" test -f /to/.migrated-from-unlisted; then
    continue
  fi
  say "Copying volume unlisted_$v to cashr_$v"
  docker compose -p unlisted --profile https down >/dev/null 2>&1 || true
  docker volume create "cashr_$v" >/dev/null
  docker run --rm -v "unlisted_$v:/from:ro" -v "cashr_$v:/to" "$ALPINE" sh -c \
    'set -e; cp -a /from/. /to/; cd /to
     for f in unlisted.db unlisted.db.lock unlisted.db-wal unlisted.db-shm; do
       if [ -e "$f" ]; then mv "$f" "cashr${f#unlisted}"; fi
     done
     touch /to/.migrated-from-unlisted'
done

if [ -z "$DOMAIN" ]; then
  ip=$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
  case "$ip" in
    10.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|192.168.*|"") ip=$(curl -fsS4 https://ifconfig.me) ;;
  esac
  DOMAIN="$(echo "$ip" | tr . -).sslip.io"
fi

if [ ! -f .env ]; then
  say "Generating secrets"
  umask 077
  cat > .env <<EOF
CASHR_NETWORK=main
CASHR_WALLET_RPC_PASSWORD=$(openssl rand -hex 24)
CASHR_WALLET_SEED_KEY=$(openssl rand -hex 32)
CASHR_CORS_ORIGINS=$WEB_ORIGIN
API_DOMAIN=$DOMAIN
CASHR_BACKUP_PASSPHRASE=$(openssl rand -hex 32)
EOF
else
  sed -i "s|^API_DOMAIN=.*|API_DOMAIN=$DOMAIN|" .env
  if [ -n "$WEB_ORIGIN_GIVEN" ]; then
    sed -i "s|^CASHR_CORS_ORIGINS=.*|CASHR_CORS_ORIGINS=$WEB_ORIGIN|" .env
  fi
  grep -q '^CASHR_BACKUP_PASSPHRASE=' .env || echo "CASHR_BACKUP_PASSPHRASE=$(openssl rand -hex 32)" >> .env
fi
chmod 600 .env

say "Nightly encrypted backup"
cat > /etc/cron.d/cashr-backup <<EOF
# cashr: encrypted backup of the data volumes (see $DIR/deploy/backup.sh)
40 3 * * * root CASHR_DIR=$DIR $DIR/deploy/backup.sh >>/var/log/cashr-backup.log 2>&1
EOF

PROFILES=(--profile https)
PULL=(wallet api caddy)
if [ "$PROXY" = none ]; then
  PROFILES=()
  PULL=(wallet api)
else
  say "Firewall: SSH, HTTP and HTTPS only"
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi
if grep -q '^COMPOSE_PROFILES=.*demo' .env; then PROFILES+=(--profile demo); PULL+=(demo-api); fi

say "Downloading and starting"
if docker compose "${PROFILES[@]}" pull --quiet "${PULL[@]}"; then
  # Tor is a small local build from Alpine's package.
  docker compose build --quiet tor
  docker compose "${PROFILES[@]}" up -d --no-build
else
  # No prebuilt image (fork, or registry unreachable): build from source.
  # That needs about 8 GB of free disk and 4 GB of memory, so add swap if short.
  if [ "$free_mb" -lt 8192 ]; then
    echo "Building from source needs about 8 GB of free disk; only ${free_mb} MB is free." >&2
    exit 1
  fi
  mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
  if [ "$mem_kb" -lt 3900000 ] && ! swapon --show | grep -q /swapfile; then
    say "Adding 4 GB of swap for the build"
    fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  say "Building from source (10-20 minutes)"
  docker compose "${PROFILES[@]}" up -d --build
fi
# Old cashr images from previous runs are no longer needed (only cashr's: the
# server may run other things).
docker image prune -f --filter "label=org.opencontainers.image.source=https://github.com/linoxbt/cashr" >/dev/null

say "Waiting for https://$DOMAIN/meta"
if [ -n "$OLD_VOLUMES" ]; then
  echo "Once cashr is confirmed working, delete the old copies (they still hold pre-rename data):"
  echo "  docker volume rm$OLD_VOLUMES"
fi
for _ in $(seq 1 120); do
  if meta=$(curl -fsS "https://$DOMAIN/meta" 2>/dev/null); then
    echo "$meta"
    break
  fi
  sleep 5
done
[ -n "${meta:-}" ] || { echo "The API did not answer yet. Check: docker compose logs --tail 50" >&2; exit 1; }

cat <<EOF

cashr backend is running.

  API URL:   https://$DOMAIN
  Next step: set NEXT_PUBLIC_API_URL=https://$DOMAIN on the web app and redeploy it.

Backups: every night at 03:40 UTC, encrypted, into /var/backups/cashr (the last 7).
  - Copy them off this machine: set CASHR_BACKUP_REMOTE=user@host:/path in $DIR/.env.
  - Keep CASHR_WALLET_SEED_KEY and CASHR_BACKUP_PASSPHRASE from $DIR/.env somewhere offline,
    apart from the backups: restoring needs the passphrase, spending needs the seed key.
    (Read them with: grep -E '^CASHR_(WALLET_SEED_KEY|BACKUP_PASSPHRASE)=' $DIR/.env)
  - Restore: see docs/DEPLOY.md.
EOF
