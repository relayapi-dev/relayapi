#!/bin/bash
# =============================================================================
# RelayAPI — Secure Postgres 18 + Cloudflare Tunnel setup
# Tested on: Ubuntu 22.04 / 24.04 (Hetzner CCX23)
#
# What this script does:
#   1.  Hardens the VPS (firewall, SSH, fail2ban, auto-updates)
#   2.  Installs PostgreSQL 18 (latest stable) from official PGDG repo
#   3.  Generates SSL certificates (PG18 does not auto-generate)
#   4.  Creates a dedicated DB + user with least privilege
#   5.  Configures pg_hba.conf with hostssl for Hyperdrive compatibility
#   6.  Installs PgBouncer (connection pooler) on port 6432
#   7.  Sets up daily automated backups (pg_dump, 7-day retention)
#   8.  Installs cloudflared and registers Tunnel as systemd service
#   9.  Configures tunnel ingress via Cloudflare API (no dashboard needed)
#  10.  Creates the DNS CNAME record automatically
#
# Usage:
#   chmod +x setup-postgres.sh
#   sudo ./setup-postgres.sh
#
# Requirements:
#   - Ubuntu 22.04 or 24.04
#   - Root access (with SSH key already in authorized_keys)
#   - A Cloudflare Tunnel token (Zero Trust → Networks → Tunnels → Create)
#   - A Cloudflare API token with: Zone:DNS:Edit + Account:Cloudflare Tunnel:Edit
# =============================================================================

set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
info() { echo -e "${BLUE}[→]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ── Must run as root ──────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && err "Run as root: sudo ./setup-postgres.sh"

# ── Detect Ubuntu codename ────────────────────────────────────────────────────
CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
[[ "$CODENAME" =~ ^(jammy|noble)$ ]] || \
  warn "Untested Ubuntu version '$CODENAME'. Script is designed for jammy (22.04) or noble (24.04)."

# =============================================================================
# COLLECT INPUTS
# =============================================================================
echo ""
echo -e "${BLUE}=============================================${NC}"
echo -e "${BLUE}  RelayAPI — Postgres 18 + Cloudflare Tunnel${NC}"
echo -e "${BLUE}=============================================${NC}"
echo ""

read -rsp "Postgres superuser password (postgres): "   PG_SUPERUSER_PASS; echo
read -rsp "Postgres app user password: "               PG_APP_PASS; echo
read -rp  "Postgres database name   [relayapi]: "      PG_DB;        PG_DB=${PG_DB:-relayapi}
read -rp  "Postgres app username    [relayapi]: "      PG_USER;      PG_USER=${PG_USER:-relayapi}
read -rp  "SSH port                 [22]: "            SSH_PORT;     SSH_PORT=${SSH_PORT:-22}
echo ""
echo "── S3 Backups (daily pg_dump to S3-compatible storage) ──────────────────"
echo "Works with AWS S3, Cloudflare R2, Backblaze B2, MinIO, etc."
echo "Leave endpoint blank to skip remote backups (local-only)."
read -rp  "S3 endpoint URL (e.g. https://<account>.r2.cloudflarestorage.com): " S3_ENDPOINT
if [[ -n "$S3_ENDPOINT" ]]; then
  read -rp  "S3 bucket name: "       S3_BUCKET
  read -rsp "S3 access key ID: "     S3_ACCESS_KEY; echo
  read -rsp "S3 secret access key: " S3_SECRET_KEY; echo
  read -rp  "S3 region       [auto]: " S3_REGION; S3_REGION=${S3_REGION:-auto}
fi
echo ""
echo "── Cloudflare Tunnel ─────────────────────────────────────────────────────"
echo "Paste your Cloudflare Tunnel token (Zero Trust → Networks → Tunnels → your tunnel → Configure → Run"
echo "connector → copy the token from the install command)"
read -rsp "Cloudflare Tunnel token: " CF_TUNNEL_TOKEN; echo
echo ""
echo "DB hostname to create (e.g. db.relayapi.dev):"
read -rp  "DB hostname: " CF_DB_HOSTNAME
echo ""
echo "Cloudflare API token (needs Zone:DNS:Edit + Account:Cloudflare Tunnel:Edit permissions):"
read -rsp "Cloudflare API token: " CF_API_TOKEN; echo
echo ""

# Validate inputs
[[ -z "$PG_SUPERUSER_PASS" ]] && err "Postgres superuser password cannot be empty"
[[ -z "$PG_APP_PASS" ]]       && err "Postgres app password cannot be empty"
[[ -z "$CF_TUNNEL_TOKEN" ]]   && err "Cloudflare Tunnel token cannot be empty"
[[ -z "$CF_DB_HOSTNAME" ]]    && err "DB hostname cannot be empty"
[[ -z "$CF_API_TOKEN" ]]      && err "Cloudflare API token cannot be empty"
[[ ${#PG_APP_PASS} -lt 16 ]]  && warn "App password is short — consider using 20+ characters"

# Derive zone name from hostname (db.relayapi.dev → relayapi.dev)
CF_ZONE_NAME=$(echo "$CF_DB_HOSTNAME" | awk -F. '{print $(NF-1)"."$NF}')
# Derive subdomain (db.relayapi.dev → db)
CF_SUBDOMAIN=$(echo "$CF_DB_HOSTNAME" | sed "s/\.${CF_ZONE_NAME}//")

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
  htop vim git jq openssl sudo python3
log "System updated"

# =============================================================================
# 2. FIREWALL (UFW)
# Only SSH is allowed inbound. Postgres/PgBouncer are localhost-only.
# The Cloudflare Tunnel is outbound — no inbound port needed.
# =============================================================================
info "Configuring firewall..."
ufw --force reset > /dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp" comment "SSH"
# Intentionally NOT opening 5432 or 6432 — Tunnel handles access
ufw --force enable > /dev/null
log "Firewall enabled — only SSH port ${SSH_PORT} is open inbound"

# =============================================================================
# 3. SSH HARDENING
# Assumes SSH key is already in /root/.ssh/authorized_keys
# =============================================================================
info "Hardening SSH..."
if ! dpkg -l openssh-server &>/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server
fi
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
systemctl restart fail2ban 2>/dev/null || service fail2ban restart 2>/dev/null || true
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
# 6. INSTALL POSTGRESQL 18
# Using official PGDG apt repo — NOT Ubuntu's older bundled version
# =============================================================================
info "Adding official PostgreSQL 18 apt repo..."

install -d /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc

echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-18 postgresql-client-18

# Ensure cluster is running (Docker blocks auto-start via policy-rc.d)
pg_ctlcluster 18 main start 2>/dev/null || true
sleep 2

PG_VERSION=$(sudo -u postgres psql -t -c "SELECT version();" | head -1 | xargs)
log "Installed: ${PG_VERSION}"

# =============================================================================
# 7. GENERATE SSL CERTIFICATES
# PG18 does NOT auto-generate SSL certs — must create manually.
# Hyperdrive requires SSL; hostssl rules in pg_hba.conf enforce it.
# =============================================================================
info "Generating SSL certificates for PostgreSQL..."

PG_SSL_DIR="/etc/postgresql/18/main"
PG_SSL_KEY="${PG_SSL_DIR}/server.key"
PG_SSL_CERT="${PG_SSL_DIR}/server.crt"

openssl req -new -x509 -days 3650 -nodes \
  -out "$PG_SSL_CERT" \
  -keyout "$PG_SSL_KEY" \
  -subj "/CN=relayapi-db" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"

chmod 600 "$PG_SSL_KEY"
chmod 644 "$PG_SSL_CERT"
chown postgres:postgres "$PG_SSL_KEY" "$PG_SSL_CERT"

log "SSL certificates generated (self-signed, 10 year expiry)"

# =============================================================================
# 8. CONFIGURE POSTGRESQL
# =============================================================================
info "Configuring PostgreSQL..."

PG_CONF="/etc/postgresql/18/main/postgresql.conf"
PG_HBA="/etc/postgresql/18/main/pg_hba.conf"

# Listen on localhost only — cloudflared runs on the VPS and connects locally
sed -i "s/^#\?listen_addresses\s*=.*/listen_addresses = 'localhost'/" "$PG_CONF"

# Enable SSL and point to our generated certs
sed -i "s|^#\?ssl\s*=.*|ssl = on|"                                           "$PG_CONF"
sed -i "s|^#\?ssl_cert_file\s*=.*|ssl_cert_file = '${PG_SSL_CERT}'|"        "$PG_CONF"
sed -i "s|^#\?ssl_key_file\s*=.*|ssl_key_file = '${PG_SSL_KEY}'|"           "$PG_CONF"

# Dynamic performance tuning based on actual server RAM
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_RAM_MB=$((TOTAL_RAM_KB / 1024))
SHARED_BUFFERS_MB=$((TOTAL_RAM_MB / 4))
EFFECTIVE_CACHE_MB=$((TOTAL_RAM_MB * 3 / 4))
MAINT_WORK_MEM_MB=$((TOTAL_RAM_MB / 16))
WORK_MEM_MB=$((TOTAL_RAM_MB / 100))
[[ $WORK_MEM_MB -lt 4 ]] && WORK_MEM_MB=4
CPU_COUNT=$(nproc)
PARALLEL_WORKERS=$(( CPU_COUNT / 2 > 0 ? CPU_COUNT / 2 : 1 ))

cat >> "$PG_CONF" << EOF

# ── RelayAPI performance tuning (auto-calculated from ${TOTAL_RAM_MB}MB RAM, ${CPU_COUNT} vCPU) ──
max_connections              = 100
shared_buffers               = ${SHARED_BUFFERS_MB}MB
effective_cache_size         = ${EFFECTIVE_CACHE_MB}MB
maintenance_work_mem         = ${MAINT_WORK_MEM_MB}MB
work_mem                     = ${WORK_MEM_MB}MB
checkpoint_completion_target = 0.9
wal_buffers                  = 16MB
default_statistics_target    = 100
random_page_cost             = 1.1
effective_io_concurrency     = 200
min_wal_size                 = 1GB
max_wal_size                 = 4GB
max_worker_processes         = ${CPU_COUNT}
max_parallel_workers_per_gather = ${PARALLEL_WORKERS}
max_parallel_workers         = ${CPU_COUNT}
log_min_duration_statement   = 1000
log_checkpoints              = on
log_connections              = off
log_disconnections           = off
EOF

# ── pg_hba.conf ────────────────────────────────────────────────────────────
# hostssl is required for Hyperdrive — it enforces SSL on the connection.
# UFW blocks port 5432 from the internet so hostssl 0.0.0.0/0 is only
# reachable via the Cloudflare Tunnel (outbound) or SSH tunnel (local dev).
# postgres superuser uses 'host' (not hostssl) for local admin tasks.
cat > "$PG_HBA" << EOF
# TYPE    DATABASE  USER      ADDRESS          METHOD
# Local socket — postgres superuser peer auth (pg_dump, psql admin, etc.)
local     all       postgres                   peer
local     all       all                        scram-sha-256

# Loopback — postgres superuser for local admin (no SSL required)
host      all       postgres  127.0.0.1/32     scram-sha-256
host      all       postgres  ::1/128          scram-sha-256

# App user — SSL required (Hyperdrive via Cloudflare Tunnel + local dev SSH tunnel)
hostssl   all       ${PG_USER}  127.0.0.1/32   scram-sha-256
hostssl   all       ${PG_USER}  ::1/128        scram-sha-256
EOF

systemctl restart postgresql 2>/dev/null || pg_ctlcluster 18 main restart || true
sleep 2
log "PostgreSQL configured (localhost only, SSL on, ${SHARED_BUFFERS_MB}MB shared_buffers)"

# =============================================================================
# 9. CREATE DATABASE AND USER
# =============================================================================
info "Creating database '${PG_DB}' and user '${PG_USER}'..."

sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD '${PG_SUPERUSER_PASS}';"

sudo -u postgres psql << EOSQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${PG_USER}') THEN
    CREATE USER ${PG_USER} WITH PASSWORD '${PG_APP_PASS}';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE ${PG_DB}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${PG_DB}')\gexec

ALTER DATABASE ${PG_DB} OWNER TO ${PG_USER};
GRANT ALL PRIVILEGES ON DATABASE ${PG_DB} TO ${PG_USER};
EOSQL

sudo -u postgres psql -d "${PG_DB}" << EOSQL
-- Public schema
GRANT USAGE ON SCHEMA public TO ${PG_USER};
GRANT CREATE ON SCHEMA public TO ${PG_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${PG_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${PG_USER};

-- Auth schema (used by Better Auth plugin — tables managed by Drizzle migrations)
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO ${PG_USER};
GRANT CREATE ON SCHEMA auth TO ${PG_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${PG_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA auth
  GRANT USAGE, SELECT ON SEQUENCES TO ${PG_USER};
EOSQL

log "Database and user created (public + auth schemas)"

# =============================================================================
# 10. INSTALL PGBOUNCER
# Kept as an optional direct-connection pooler on 6432.
# Hyperdrive bypasses PgBouncer and connects directly to Postgres:5432.
# =============================================================================
info "Installing PgBouncer..."
apt-get install -y -qq pgbouncer

cat > /etc/pgbouncer/pgbouncer.ini << EOF
[databases]
${PG_DB} = host=127.0.0.1 port=5432 dbname=${PG_DB} user=${PG_USER}

[pgbouncer]
listen_addr          = 127.0.0.1
listen_port          = 6432
auth_type            = plain
auth_file            = /etc/pgbouncer/userlist.txt
pool_mode            = transaction
max_client_conn      = 1000
default_pool_size    = 25
min_pool_size        = 5
reserve_pool_size    = 5
reserve_pool_timeout = 3
server_idle_timeout  = 600
log_connections      = 0
log_disconnections   = 0
log_pooler_errors    = 1
stats_period         = 60
admin_users          = postgres
EOF

cat > /etc/pgbouncer/userlist.txt << EOF
"${PG_USER}" "${PG_APP_PASS}"
EOF

chmod 600 /etc/pgbouncer/userlist.txt
chmod 640 /etc/pgbouncer/pgbouncer.ini
chown postgres:postgres /etc/pgbouncer/userlist.txt /etc/pgbouncer/pgbouncer.ini

systemctl enable pgbouncer --quiet 2>/dev/null || true
systemctl restart pgbouncer 2>/dev/null || service pgbouncer restart 2>/dev/null || true
sleep 2

if PGPASSWORD="$PG_APP_PASS" psql \
    -h 127.0.0.1 -p 6432 -U "$PG_USER" -d "$PG_DB" \
    -c "SELECT 1 AS ok;" > /dev/null 2>&1; then
  log "PgBouncer running and connection verified ✓"
else
  warn "PgBouncer connection test failed — check: journalctl -u pgbouncer -n 50"
fi

# =============================================================================
# 11. AUTOMATED DAILY BACKUPS
# Runs pg_dump daily at 3am → uploads to S3-compatible storage.
# Also keeps 2 local copies as fast-restore fallback.
# =============================================================================
info "Setting up daily database backups..."

BACKUP_DIR="/var/backups/postgresql"
mkdir -p "$BACKUP_DIR"
chown postgres:postgres "$BACKUP_DIR"

if [[ -n "${S3_ENDPOINT:-}" ]]; then
  # Install AWS CLI (works with any S3-compatible API)
  info "Installing AWS CLI for S3 backups..."
  apt-get install -y -qq awscli 2>/dev/null || pip3 install awscli --quiet 2>/dev/null || true

  # Store S3 credentials (chmod 600, only root can read)
  cat > /etc/relayapi-backup.env << EOF
AWS_ACCESS_KEY_ID=${S3_ACCESS_KEY}
AWS_SECRET_ACCESS_KEY=${S3_SECRET_KEY}
AWS_DEFAULT_REGION=${S3_REGION}
S3_ENDPOINT=${S3_ENDPOINT}
S3_BUCKET=${S3_BUCKET}
EOF
  chmod 600 /etc/relayapi-backup.env
  log "S3 credentials saved to /etc/relayapi-backup.env"
fi

cat > /usr/local/bin/pg-backup.sh << 'BSCRIPT'
#!/bin/bash
set -euo pipefail

BACKUP_DIR="/var/backups/postgresql"
DB_NAME="PG_DB_PLACEHOLDER"
KEEP_LOCAL=2
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.sql.gz"

# Dump and compress
sudo -u postgres pg_dump "$DB_NAME" | gzip > "$BACKUP_FILE"
SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[$(date)] Backup created: $BACKUP_FILE ($SIZE)"

# Upload to S3 if configured
if [[ -f /etc/relayapi-backup.env ]]; then
  source /etc/relayapi-backup.env
  S3_PATH="s3://${S3_BUCKET}/backups/${DB_NAME}_${TIMESTAMP}.sql.gz"

  aws s3 cp "$BACKUP_FILE" "$S3_PATH" \
    --endpoint-url "$S3_ENDPOINT" \
    --quiet

  if [[ $? -eq 0 ]]; then
    echo "[$(date)] Uploaded to $S3_PATH"
  else
    echo "[$(date)] S3 upload FAILED — local backup retained" >&2
  fi

  # Clean up old remote backups (keep 30 days)
  CUTOFF=$(date -d '30 days ago' +%Y%m%d 2>/dev/null || date -v-30d +%Y%m%d 2>/dev/null || echo "")
  if [[ -n "$CUTOFF" ]]; then
    aws s3 ls "s3://${S3_BUCKET}/backups/" --endpoint-url "$S3_ENDPOINT" 2>/dev/null | while read -r line; do
      FILE_DATE=$(echo "$line" | grep -oP '\d{8}(?=_)' || echo "")
      FILE_NAME=$(echo "$line" | awk '{print $NF}')
      if [[ -n "$FILE_DATE" ]] && [[ "$FILE_DATE" < "$CUTOFF" ]]; then
        aws s3 rm "s3://${S3_BUCKET}/backups/${FILE_NAME}" --endpoint-url "$S3_ENDPOINT" --quiet
        echo "[$(date)] Deleted old remote backup: $FILE_NAME"
      fi
    done
  fi
fi

# Keep only KEEP_LOCAL most recent local backups
ls -t "${BACKUP_DIR}/"*.sql.gz 2>/dev/null | tail -n +$((KEEP_LOCAL + 1)) | xargs rm -f 2>/dev/null || true
BSCRIPT

# Replace placeholder with actual DB name
sed -i "s|PG_DB_PLACEHOLDER|${PG_DB}|" /usr/local/bin/pg-backup.sh
chmod +x /usr/local/bin/pg-backup.sh

# Run at 3am daily
(crontab -l 2>/dev/null | grep -v pg-backup; echo "0 3 * * * /usr/local/bin/pg-backup.sh >> /var/log/pg-backup.log 2>&1") | crontab -

if [[ -n "${S3_ENDPOINT:-}" ]]; then
  log "Daily backup cron set (3am → S3: ${S3_BUCKET}, 30-day retention + 2 local copies)"
else
  log "Daily backup cron set (3am, local only — 2 copies in ${BACKUP_DIR})"
  warn "No S3 configured — backups are local only. If the VPS dies, backups are lost."
fi

# =============================================================================
# 12. INSTALL CLOUDFLARED + REGISTER TUNNEL
# =============================================================================
info "Installing cloudflared..."

curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  -o /usr/share/keyrings/cloudflare-main.gpg

echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
https://pkg.cloudflare.com/cloudflared ${CODENAME} main" \
  > /etc/apt/sources.list.d/cloudflared.list

apt-get update -qq
apt-get install -y -qq cloudflared
log "cloudflared installed: $(cloudflared --version 2>&1 | head -1)"

info "Registering Cloudflare Tunnel as systemd service..."
cloudflared service install "$CF_TUNNEL_TOKEN"

systemctl enable cloudflared --quiet 2>/dev/null || true
systemctl start cloudflared 2>/dev/null || true
sleep 5

if systemctl is-active --quiet cloudflared; then
  log "Cloudflare Tunnel running"
else
  warn "Tunnel failed to start — check: journalctl -u cloudflared -n 50"
fi

# =============================================================================
# 13. CONFIGURE TUNNEL INGRESS + DNS VIA CLOUDFLARE API
# Extracts Tunnel ID and Account ID from the token (it's a base64 JSON payload)
# then uses the API to:
#   a) Set ingress rule: CF_DB_HOSTNAME → tcp://localhost:5432
#   b) Create CNAME DNS record: CF_SUBDOMAIN → <tunnel-id>.cfargotunnel.com
# =============================================================================
info "Configuring tunnel ingress and DNS via Cloudflare API..."

# Decode tunnel token to extract account ID and tunnel ID
# Token format: <header>.<payload>.<sig> where payload is base64url JSON
# {"a": "<account_id>", "t": "<tunnel_id>", "s": "<secret>"}
TOKEN_PAYLOAD=$(echo "$CF_TUNNEL_TOKEN" | cut -d'.' -f2)
# Add padding if needed for base64 decode
PADDED=$(python3 -c "
import base64, sys
s = sys.argv[1]
s += '=' * (4 - len(s) % 4) if len(s) % 4 else ''
print(base64.b64decode(s).decode('utf-8'))
" "$TOKEN_PAYLOAD" 2>/dev/null || echo "")

if [[ -n "$PADDED" ]]; then
  CF_ACCOUNT_ID=$(echo "$PADDED" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('a',''))" 2>/dev/null || echo "")
  CF_TUNNEL_ID=$(echo "$PADDED"  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('t',''))" 2>/dev/null || echo "")
fi

if [[ -z "${CF_ACCOUNT_ID:-}" ]] || [[ -z "${CF_TUNNEL_ID:-}" ]]; then
  warn "Could not auto-extract tunnel/account ID from token — please enter manually:"
  read -rp "Cloudflare Account ID: " CF_ACCOUNT_ID
  read -rp "Cloudflare Tunnel ID (UUID): " CF_TUNNEL_ID
fi

info "Account ID : $CF_ACCOUNT_ID"
info "Tunnel ID  : $CF_TUNNEL_ID"
info "Zone       : $CF_ZONE_NAME"
info "Subdomain  : $CF_SUBDOMAIN → localhost:5432"

# a) Get Zone ID
CF_ZONE_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones?name=${CF_ZONE_NAME}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
zones = data.get('result', [])
print(zones[0]['id'] if zones else '')
" 2>/dev/null || echo "")

if [[ -z "$CF_ZONE_ID" ]]; then
  warn "Could not find zone '${CF_ZONE_NAME}' via API — check your API token has Zone:Read permission"
  warn "You will need to create the DNS record manually in the Cloudflare dashboard"
else
  log "Zone ID: $CF_ZONE_ID"

  # b) Configure tunnel ingress (points hostname to local postgres)
  INGRESS_RESP=$(curl -s -X PUT \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_ID}/configurations" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"config\": {
        \"ingress\": [
          {
            \"hostname\": \"${CF_DB_HOSTNAME}\",
            \"service\": \"tcp://localhost:5432\",
            \"originRequest\": {
              \"connectTimeout\": 30,
              \"tcpKeepAlive\": 30,
              \"noHappyEyeballs\": false
            }
          },
          {
            \"service\": \"http_status:404\"
          }
        ]
      }
    }")

  if echo "$INGRESS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('success') else 1)" 2>/dev/null; then
    log "Tunnel ingress configured: ${CF_DB_HOSTNAME} → tcp://localhost:5432"
  else
    warn "Tunnel ingress API call failed. Response:"
    echo "$INGRESS_RESP" | python3 -m json.tool 2>/dev/null || echo "$INGRESS_RESP"
    warn "Configure manually: Zero Trust → Tunnels → your tunnel → Public Hostname"
    warn "  Hostname: ${CF_DB_HOSTNAME}, Service: TCP, URL: localhost:5432"
  fi

  # c) Create DNS CNAME record
  DNS_RESP=$(curl -s -X POST \
    "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"type\": \"CNAME\",
      \"name\": \"${CF_SUBDOMAIN}\",
      \"content\": \"${CF_TUNNEL_ID}.cfargotunnel.com\",
      \"proxied\": true,
      \"comment\": \"RelayAPI DB tunnel\"
    }")

  if echo "$DNS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('success') else 1)" 2>/dev/null; then
    log "DNS CNAME created: ${CF_DB_HOSTNAME} → ${CF_TUNNEL_ID}.cfargotunnel.com"
  else
    # Check if it already exists
    DNS_ERR=$(echo "$DNS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); errs=d.get('errors',[]); print(errs[0].get('message','') if errs else '')" 2>/dev/null || echo "")
    if echo "$DNS_ERR" | grep -qi "already exist"; then
      warn "DNS record already exists — skipping"
    else
      warn "DNS record creation failed:"
      echo "$DNS_RESP" | python3 -m json.tool 2>/dev/null || echo "$DNS_RESP"
    fi
  fi
fi

# =============================================================================
# 14. FINAL SERVICE CHECK
# =============================================================================
echo ""
info "Service status:"
for svc in postgresql pgbouncer cloudflared fail2ban; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    log "  $svc"
  else
    warn "  $svc — NOT running"
  fi
done

# =============================================================================
# 15. SUMMARY
# =============================================================================
echo ""
echo -e "${GREEN}=============================================${NC}"
echo -e "${GREEN}  Done!${NC}"
echo -e "${GREEN}=============================================${NC}"
echo ""
echo -e "  Postgres 18    ${BLUE}localhost:5432${NC} (SSL enabled)"
echo -e "  PgBouncer      ${BLUE}localhost:6432${NC} (optional, for direct connections)"
echo -e "  Database       ${BLUE}${PG_DB}${NC}"
echo -e "  User           ${BLUE}${PG_USER}${NC}"
echo -e "  Tunnel         ${BLUE}${CF_DB_HOSTNAME}${NC} → localhost:5432"
if [[ -n "${S3_ENDPOINT:-}" ]]; then
echo -e "  Backups        ${BLUE}s3://${S3_BUCKET}/backups/${NC} (30-day retention)"
else
echo -e "  Backups        ${BLUE}${BACKUP_DIR}${NC} (local only — 2 copies)"
fi
echo -e "  Open ports     ${BLUE}SSH :${SSH_PORT} only${NC}"
echo ""
echo -e "  ${YELLOW}Next steps:${NC}"
echo ""
echo "  1. Create Hyperdrive (run from your local machine):"
echo "     wrangler hyperdrive create relayapi-db \\"
echo "       --connection-string=\"postgres://${PG_USER}:<pass>@${CF_DB_HOSTNAME}:5432/${PG_DB}\""
echo ""
echo "  2. Add to apps/api/wrangler.toml:"
echo "     [[hyperdrive]]"
echo "     binding = \"HYPERDRIVE\""
echo "     id = \"<id from step 1>\""
echo ""
echo "  3. Local dev (SSH tunnel):"
echo "     ssh -L 5432:127.0.0.1:5432 root@<VPS_IP> -N"
echo "     DATABASE_URL=postgres://${PG_USER}:<pass>@localhost:5432/${PG_DB}?sslmode=require"
echo ""
echo "  4. Run Drizzle migrations:"
echo "     cd packages/db && bun run db:migrate"
echo ""
echo -e "  ${RED}Save your passwords somewhere safe now.${NC}"
