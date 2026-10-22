#!/usr/bin/env bash
# One-command install of the Unlisted backend (wallet + API + HTTPS) on a fresh
# Ubuntu 22.04/24.04 server. Run as root:
#
#   curl -fsSL https://raw.githubusercontent.com/linoxbt/cashr/main/deploy/install.sh | bash -s -- [api-domain] [web-origin]
#
# api-domain  Hostname whose DNS A record points at this server (e.g. api.example.com).
#             Omit it to use <ip>.sslip.io, which needs no DNS setup.
# web-origin  Where the web app lives (default https://unlisted-zec.netlify.app).
#
# Re-running it updates to the latest images and restarts the services; secrets are kept.
set -euo pipefail

DOMAIN="${1:-}"
WEB_ORIGIN="${2:-https://unlisted-zec.netlify.app}"
REPO="${UNLISTED_REPO:-https://github.com/linoxbt/cashr.git}"
BRANCH="${UNLISTED_BRANCH:-main}"
DIR="${UNLISTED_DIR:-/opt/unlisted}"

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
  echo "Only ${free_mb} MB of disk is free; Unlisted needs at least 2 GB. Free some space and re-run." >&2
  echo "Biggest directories:  du -xh / --max-depth=2 2>/dev/null | sort -h | tail -15" >&2
  echo "Unused Docker data:   docker system df   (then e.g. docker builder prune)" >&2
  exit 1
fi

say "Fetching Unlisted ($BRANCH)"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q --depth 1 origin "$BRANCH" && git -C "$DIR" reset -q --hard FETCH_HEAD
else
  git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

if [ -z "$DOMAIN" ]; then
  ip=$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
  case "$ip" in
    10.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|192.168.*|"") ip=$(curl -fsS4 https://ifconfig.me) ;;
  esac
  DOMAIN="$(echo "$ip" | tr . -).sslip.io"
fi

NEW=0
if [ ! -f .env ]; then
  say "Generating secrets"
  umask 077
  cat > .env <<EOF
UNLISTED_NETWORK=main
UNLISTED_SECRET=$(openssl rand -hex 32)
UW_RPC_PASSWORD=$(openssl rand -hex 24)
UW_SEED_KEY=$(openssl rand -hex 32)
UNLISTED_CORS_ORIGINS=$WEB_ORIGIN
API_DOMAIN=$DOMAIN
EOF
  NEW=1
else
  sed -i "s|^API_DOMAIN=.*|API_DOMAIN=$DOMAIN|; s|^UNLISTED_CORS_ORIGINS=.*|UNLISTED_CORS_ORIGINS=$WEB_ORIGIN|" .env
fi
chmod 600 .env

say "Firewall: SSH, HTTP and HTTPS only"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

say "Downloading and starting"
if docker compose --profile https pull --quiet wallet api caddy; then
  # Tor is a small local build from Alpine's package.
  docker compose build --quiet tor
  docker compose --profile https up -d --no-build
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
  docker compose --profile https up -d --build
fi
# Old images from previous runs are no longer needed.
docker image prune -f >/dev/null

say "Waiting for https://$DOMAIN/meta"
for _ in $(seq 1 120); do
  if meta=$(curl -fsS "https://$DOMAIN/meta" 2>/dev/null); then
    echo "$meta"
    break
  fi
  sleep 5
done
[ -n "${meta:-}" ] || { echo "The API did not answer yet. Check: docker compose logs --tail 50" >&2; exit 1; }

cat <<EOF

Unlisted backend is running.

  API URL:   https://$DOMAIN
  Next step: set NEXT_PUBLIC_API_URL=https://$DOMAIN on the web app and redeploy it.

Back up, separately and offline:
  1. The wallet volume, encrypted (you choose a passphrase):
       docker run --rm -v unlisted_wallet-data:/d alpine tar cz -C /d . | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -out wallet-backup.tgz.enc
     Restore:
       openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in wallet-backup.tgz.enc | docker run --rm -i -v unlisted_wallet-data:/d alpine tar xz -C /d
  2. UW_SEED_KEY from $DIR/.env
Spending needs both. Privacy doesn't: the volume alone holds every live event's ticket hashes and refund
addresses, so never keep it unencrypted. A backup also keeps events purged after it was taken: replace old
backups after a purge.
EOF
if [ "$NEW" = 1 ]; then
  echo
  echo "UW_SEED_KEY (shown once here; it is also in $DIR/.env): $(grep '^UW_SEED_KEY=' .env | cut -d= -f2)"
fi
