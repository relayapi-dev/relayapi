#!/bin/bash
# =============================================================================
# RelayAPI — Downloader Service VPS Setup
# Tested on: Ubuntu 22.04 / 24.04 (Hetzner CX22 / DigitalOcean etc.)
#
# What this script does:
#   1.  Hardens the VPS (firewall, SSH, fail2ban, auto-updates)
#   2.  Installs Docker Engine
#   3.  Pulls and runs the relayapi-downloader container
#   4.  Installs Caddy for automatic HTTPS reverse proxy
#   5.  Configures DNS hostname via Cloudflare API
#   6.  Sets up auto-update cron (pulls latest image daily)
#
# Usage:
#   chmod +x setup-vps.sh
#   sudo ./setup-vps.sh
#
# Requirements:
#   - Ubuntu 22.04 or 24.04
#   - Root access (with SSH key already in authorized_keys)
#   - A domain pointed to this VPS IP (or Cloudflare API token to create it)
# =============================================================================

set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
info() { echo -e "${BLUE}[→]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ── Must run as root ──────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && err "Run as root: sudo ./setup-vps.sh"

# ── Detect Ubuntu codename ────────────────────────────────────────────────────
CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
[[ "$CODENAME" =~ ^(jammy|noble)$ ]] || \
  warn "Untested Ubuntu version '$CODENAME'. Script is designed for jammy (22.04) or noble (24.04)."

# =============================================================================
# COLLECT INPUTS
# =============================================================================
echo ""
echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  RelayAPI — Downloader Service VPS Setup${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""

read -rsp "Internal API key (shared secret with Cloudflare Workers): " INTERNAL_API_KEY; echo
read -rp  "Hostname for this service (e.g. dl.relayapi.dev): "         DL_HOSTNAME
read -rp  "SSH port                  [22]: "                           SSH_PORT; SSH_PORT=${SSH_PORT:-22}
read -rp  "Docker image              [zanhk/relayapi-downloader:latest]: " DOCKER_IMAGE; DOCKER_IMAGE=${DOCKER_IMAGE:-zanhk/relayapi-downloader:latest}
echo ""
echo "── DNS (optional) ─────────────────────────────────────────────────────"
echo "If you want this script to create the DNS A record automatically,"
echo "provide a Cloudflare API token. Otherwise leave blank and create it manually."
read -rsp "Cloudflare API token (Zone:DNS:Edit) [skip]: " CF_API_TOKEN; echo
echo ""

# Validate inputs
[[ -z "$INTERNAL_API_KEY" ]] && err "Internal API key cannot be empty"
[[ -z "$DL_HOSTNAME" ]]      && err "Hostname cannot be empty"
[[ ${#INTERNAL_API_KEY} -lt 16 ]] && warn "API key is short — consider using 32+ hex characters"

info "Starting setup. This will take ~3 minutes..."
echo ""

# =============================================================================
# 1. SYSTEM UPDATE
# =============================================================================
info "Updating system packages..."
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq
apt-get install -y -qq \
  curl wget gnupg2 lsb-release ca-certificates \
  ufw fail2ban unattended-upgrades apt-transport-https \
  htop vim jq openssl sudo
log "System updated"

# =============================================================================
# 2. FIREWALL (UFW)
# Only SSH + HTTP + HTTPS open. Docker port 8000 is localhost-only.
# =============================================================================
info "Configuring firewall..."
ufw --force reset > /dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp" comment "SSH"
ufw allow 80/tcp  comment "HTTP (Caddy ACME challenge)"
ufw allow 443/tcp comment "HTTPS (Caddy reverse proxy)"
ufw --force enable > /dev/null
log "Firewall enabled — SSH:${SSH_PORT}, HTTP:80, HTTPS:443"

# =============================================================================
# 3. SSH HARDENING
# =============================================================================
info "Hardening SSH..."
SSH_CONFIG="/etc/ssh/sshd_config"
cp "$SSH_CONFIG" "${SSH_CONFIG}.bak.$(date +%s)"

grep -q "^PermitRootLogin" "$SSH_CONFIG" \
  && sed -i 's/^PermitRootLogin.*/PermitRootLogin prohibit-password/' "$SSH_CONFIG" \
  || echo "PermitRootLogin prohibit-password" >> "$SSH_CONFIG"

grep -q "^PasswordAuthentication" "$SSH_CONFIG" \
  && sed -i 's/^PasswordAuthentication.*/PasswordAuthentication no/' "$SSH_CONFIG" \
  || echo "PasswordAuthentication no" >> "$SSH_CONFIG"

grep -q "^X11Forwarding" "$SSH_CONFIG" \
  && sed -i 's/^X11Forwarding.*/X11Forwarding no/' "$SSH_CONFIG" \
  || echo "X11Forwarding no" >> "$SSH_CONFIG"

grep -q "^MaxAuthTries"        "$SSH_CONFIG" || echo "MaxAuthTries 3"          >> "$SSH_CONFIG"
grep -q "^ClientAliveInterval" "$SSH_CONFIG" || echo "ClientAliveInterval 300" >> "$SSH_CONFIG"

systemctl reload sshd 2>/dev/null || service ssh reload 2>/dev/null || true
log "SSH hardened (key-only login, password auth disabled)"

# =============================================================================
# 4. FAIL2BAN
# =============================================================================
info "Configuring fail2ban..."
cat > /etc/fail2ban/jail.local << EOF
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port    = ${SSH_PORT}
EOF
systemctl enable fail2ban --quiet 2>/dev/null || true
systemctl restart fail2ban 2>/dev/null || true
log "fail2ban enabled (bans after 5 failed SSH attempts)"

# =============================================================================
# 5. AUTOMATIC SECURITY UPDATES
# =============================================================================
info "Enabling automatic security updates..."
cat > /etc/apt/apt.conf.d/50unattended-upgrades << 'EOF'
Unattended-Upgrade::Allowed-Origins {
  "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
systemctl enable unattended-upgrades --quiet 2>/dev/null || true
log "Automatic security updates enabled"

# =============================================================================
# 6. INSTALL DOCKER ENGINE
# =============================================================================
info "Installing Docker Engine..."

# Remove old versions
apt-get remove -y -qq docker docker-engine docker.io containerd runc 2>/dev/null || true

# Add Docker's official GPG key and repo
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu ${CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable docker --quiet 2>/dev/null || true
systemctl start docker 2>/dev/null || true

log "Docker installed: $(docker --version)"

# =============================================================================
# 7. PULL AND RUN DOWNLOADER CONTAINER
# =============================================================================
info "Pulling downloader image: ${DOCKER_IMAGE}..."
docker pull "$DOCKER_IMAGE"

info "Starting downloader container..."

# Stop existing container if running
docker stop relayapi-downloader 2>/dev/null || true
docker rm relayapi-downloader 2>/dev/null || true

docker run -d \
  --name relayapi-downloader \
  --restart unless-stopped \
  -p 127.0.0.1:8000:8000 \
  -e INTERNAL_API_KEY="$INTERNAL_API_KEY" \
  -e PORT=8000 \
  -e REQUEST_TIMEOUT=60 \
  "$DOCKER_IMAGE"

sleep 3

if docker ps --filter "name=relayapi-downloader" --filter "status=running" -q | grep -q .; then
  log "Downloader container running on localhost:8000"
else
  warn "Container failed to start — check: docker logs relayapi-downloader"
fi

# Health check
if curl -sf http://127.0.0.1:8000/health > /dev/null 2>&1; then
  HEALTH=$(curl -s http://127.0.0.1:8000/health)
  log "Health check passed: ${HEALTH}"
else
  warn "Health check failed — container may still be starting up"
fi

# =============================================================================
# 8. INSTALL CADDY (AUTOMATIC HTTPS REVERSE PROXY)
# =============================================================================
info "Installing Caddy..."

apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy

# Configure Caddy as reverse proxy
cat > /etc/caddy/Caddyfile << EOF
${DL_HOSTNAME} {
    reverse_proxy localhost:8000

    # Security headers
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy no-referrer
        -Server
    }

    # Access logging
    log {
        output file /var/log/caddy/access.log {
            roll_size 10mb
            roll_keep 5
        }
    }
}
EOF

mkdir -p /var/log/caddy
systemctl enable caddy --quiet 2>/dev/null || true
systemctl restart caddy 2>/dev/null || true
sleep 3

if systemctl is-active --quiet caddy; then
  log "Caddy running — HTTPS reverse proxy for ${DL_HOSTNAME}"
else
  warn "Caddy failed to start — check: journalctl -u caddy -n 50"
  warn "Make sure ${DL_HOSTNAME} DNS points to this server's IP before Caddy can get a TLS certificate"
fi

# =============================================================================
# 9. DNS RECORD (OPTIONAL — via Cloudflare API)
# =============================================================================
if [[ -n "${CF_API_TOKEN:-}" ]]; then
  info "Creating DNS A record via Cloudflare API..."

  VPS_IP=$(curl -4 -sf https://ifconfig.me || curl -4 -sf https://icanhazip.com || echo "")

  if [[ -z "$VPS_IP" ]]; then
    warn "Could not detect public IP — create DNS record manually"
  else
    # Derive zone name (dl.relayapi.dev → relayapi.dev)
    CF_ZONE_NAME=$(echo "$DL_HOSTNAME" | awk -F. '{print $(NF-1)"."$NF}')
    CF_SUBDOMAIN=$(echo "$DL_HOSTNAME" | sed "s/\.${CF_ZONE_NAME}//")

    # Get zone ID
    CF_ZONE_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones?name=${CF_ZONE_NAME}" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" \
      -H "Content-Type: application/json" | jq -r '.result[0].id // empty')

    if [[ -z "$CF_ZONE_ID" ]]; then
      warn "Could not find zone '${CF_ZONE_NAME}' — create DNS record manually"
    else
      # Create A record (not proxied — Caddy handles TLS directly)
      DNS_RESP=$(curl -s -X POST \
        "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records" \
        -H "Authorization: Bearer ${CF_API_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{
          \"type\": \"A\",
          \"name\": \"${CF_SUBDOMAIN}\",
          \"content\": \"${VPS_IP}\",
          \"proxied\": false,
          \"ttl\": 300,
          \"comment\": \"RelayAPI downloader service\"
        }")

      if echo "$DNS_RESP" | jq -e '.success' > /dev/null 2>&1; then
        log "DNS A record created: ${DL_HOSTNAME} → ${VPS_IP}"
      else
        DNS_ERR=$(echo "$DNS_RESP" | jq -r '.errors[0].message // "unknown error"' 2>/dev/null)
        if echo "$DNS_ERR" | grep -qi "already exist"; then
          warn "DNS record already exists — skipping"
        else
          warn "DNS creation failed: ${DNS_ERR}"
          warn "Create manually: A record, ${DL_HOSTNAME} → ${VPS_IP}, DNS only (no proxy)"
        fi
      fi
    fi
  fi
else
  info "Skipping DNS setup (no Cloudflare API token provided)"
  warn "Create an A record manually: ${DL_HOSTNAME} → <this server's IP>"
  warn "Set it to DNS-only (no orange cloud proxy) so Caddy can get a TLS certificate"
fi

# =============================================================================
# 10. AUTO-UPDATE CRON
# Pulls latest Docker image daily at 4am and restarts if changed.
# =============================================================================
info "Setting up daily auto-update cron..."

cat > /usr/local/bin/update-downloader.sh << 'SCRIPT'
#!/bin/bash
IMAGE="DOCKER_IMAGE_PLACEHOLDER"
docker pull "$IMAGE" 2>/dev/null

RUNNING=$(docker inspect --format='{{.Image}}' relayapi-downloader 2>/dev/null || echo "")
LATEST=$(docker inspect --format='{{.Id}}' "$IMAGE" 2>/dev/null || echo "")

if [[ "$RUNNING" != "$LATEST" ]] && [[ -n "$LATEST" ]]; then
  echo "[$(date)] Updating relayapi-downloader to new image..."
  docker stop relayapi-downloader
  docker rm relayapi-downloader
  docker run -d \
    --name relayapi-downloader \
    --restart unless-stopped \
    -p 127.0.0.1:8000:8000 \
    --env-file /etc/relayapi-downloader.env \
    "$IMAGE"
  docker image prune -f
  echo "[$(date)] Update complete"
else
  echo "[$(date)] Already on latest image"
fi
SCRIPT

# Replace placeholder with actual image name
sed -i "s|DOCKER_IMAGE_PLACEHOLDER|${DOCKER_IMAGE}|" /usr/local/bin/update-downloader.sh
chmod +x /usr/local/bin/update-downloader.sh

# Save env vars for the auto-updater to use
cat > /etc/relayapi-downloader.env << EOF
INTERNAL_API_KEY=${INTERNAL_API_KEY}
PORT=8000
REQUEST_TIMEOUT=60
EOF
chmod 600 /etc/relayapi-downloader.env

# Add cron job (4am daily)
(crontab -l 2>/dev/null | grep -v update-downloader; echo "0 4 * * * /usr/local/bin/update-downloader.sh >> /var/log/downloader-update.log 2>&1") | crontab -
log "Auto-update cron set (pulls latest image daily at 4am)"

# =============================================================================
# 11. FINAL SERVICE CHECK
# =============================================================================
echo ""
info "Service status:"
for svc in docker caddy fail2ban; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    log "  $svc"
  else
    warn "  $svc — NOT running"
  fi
done

if docker ps --filter "name=relayapi-downloader" --filter "status=running" -q | grep -q .; then
  log "  relayapi-downloader (Docker)"
else
  warn "  relayapi-downloader — NOT running"
fi

# =============================================================================
# 12. SUMMARY
# =============================================================================
echo ""
echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}  Done!${NC}"
echo -e "${GREEN}================================================${NC}"
echo ""
echo -e "  Downloader      ${BLUE}localhost:8000${NC} (Docker)"
echo -e "  Caddy HTTPS     ${BLUE}https://${DL_HOSTNAME}${NC} → localhost:8000"
echo -e "  Docker image    ${BLUE}${DOCKER_IMAGE}${NC}"
echo -e "  Open ports      ${BLUE}SSH:${SSH_PORT}, HTTP:80, HTTPS:443${NC}"
echo -e "  Auto-update     ${BLUE}Daily at 4am UTC${NC}"
echo -e "  Env file        ${BLUE}/etc/relayapi-downloader.env${NC} (chmod 600)"
echo ""
echo -e "  ${YELLOW}Next steps:${NC}"
echo ""
echo "  1. Verify HTTPS is working:"
echo "     curl https://${DL_HOSTNAME}/health"
echo ""
echo "  2. If DNS was not auto-created, add an A record:"
echo "     ${DL_HOSTNAME} → $(curl -4 -sf https://ifconfig.me 2>/dev/null || echo '<VPS_IP>')"
echo "     Set to DNS-only (grey cloud / no proxy) in Cloudflare"
echo ""
echo "  3. Test from your machine:"
echo "     curl -H 'X-Internal-Key: <your-key>' https://${DL_HOSTNAME}/health"
echo ""
echo -e "  ${YELLOW}Useful commands:${NC}"
echo ""
echo "  docker logs relayapi-downloader -f     # Live logs"
echo "  docker restart relayapi-downloader     # Restart"
echo "  /usr/local/bin/update-downloader.sh    # Manual update"
echo "  journalctl -u caddy -f                 # Caddy logs"
echo "  cat /var/log/downloader-update.log     # Update history"
echo ""
