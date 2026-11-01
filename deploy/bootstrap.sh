#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu VPS for Pulse. Run as root:
#   DEPLOY_PUBKEY="ssh-ed25519 AAAA... you@laptop" bash bootstrap.sh
# Installs Docker, creates the non-root `deploy` user (docker group, key-only login), opens only 22/80/443 and
# turns on fail2ban and unattended security updates. It does NOT touch sshd_config: password and root logins keep
# working until you decide otherwise (see `harden-ssh` at the bottom of deploy/README.md).
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
: "${DEPLOY_PUBKEY:?set DEPLOY_PUBKEY to the public key that may log in as the deploy user}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
APP_DIR="${APP_DIR:-/opt/pulse}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw fail2ban unattended-upgrades

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

# Small VPS (<= 2 GB): the Next.js image build needs headroom, so make sure there is swap.
if [ "$(swapon --show --noheadings | wc -l)" -eq 0 ] && [ "$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)" -lt 3500 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
# DEPLOY_PUBKEY may hold several keys, one per line
while IFS= read -r key; do
  [ -n "$key" ] && { grep -qxF "$key" "/home/$DEPLOY_USER/.ssh/authorized_keys" || echo "$key" >> "/home/$DEPLOY_USER/.ssh/authorized_keys"; }
done <<< "$DEPLOY_PUBKEY"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"

install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR" "$APP_DIR/releases" "$APP_DIR/backups"

# Firewall: SSH, HTTP (ACME + redirect), HTTPS. Postgres and Redis are never published.
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades || true

echo "bootstrap done: docker $(docker --version | cut -d' ' -f3 | tr -d ,), user $DEPLOY_USER, app dir $APP_DIR"
