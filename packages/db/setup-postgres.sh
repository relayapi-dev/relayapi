#!/usr/bin/env bash
# =============================================================================
# RelayAPI — PostgreSQL 18 origin for Cloudflare Workers VPC + Hyperdrive
#
# This provisions one PostgreSQL origin on Ubuntu 22.04/24.04. It intentionally:
#   - keeps PostgreSQL private and reachable only from the local tunnel connector;
#   - preserves existing UFW rules and the SSH port that sshd actually uses;
#   - separates no-login owner, migration, and no-DDL runtime roles;
#   - requires a trusted TLS certificate whose SAN matches the private VPC name;
#   - relies on Hyperdrive for pooling (no PgBouncer);
#   - leaves backups to the independently operated backup system.
#
# The preferred runtime path is:
# Worker -> Hyperdrive -> Workers VPC service -> Tunnel -> PostgreSQL.
# A separate Access-protected TCP hostname may be configured for CI migrations.
# This script never publishes an unprotected TCP hostname.
# =============================================================================

set -euo pipefail
umask 077

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${GREEN}[ok]${NC} $1"; }
info() { echo -e "${BLUE}[..]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; }
die() { echo -e "${RED}[error]${NC} $1" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "Run as root: sudo ./setup-postgres.sh"

CODENAME=$(. /etc/os-release && printf '%s' "$VERSION_CODENAME")
[[ "$CODENAME" =~ ^(jammy|noble)$ ]] || \
	warn "Ubuntu '$CODENAME' is not one of the tested releases (jammy, noble)."

valid_identifier() {
	[[ "$1" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]
}

read_secret() {
	local prompt=$1
	local variable=$2
	local value
	read -rsp "$prompt" value
	echo
	printf -v "$variable" '%s' "$value"
}

echo
echo "RelayAPI PostgreSQL 18 private-origin setup"
echo

read -rp "Database name [relayapi]: " PG_DB
PG_DB=${PG_DB:-relayapi}
read -rp "No-login owner role [relayapi_owner]: " PG_OWNER_ROLE
PG_OWNER_ROLE=${PG_OWNER_ROLE:-relayapi_owner}
read -rp "Migration role [relayapi_migrator]: " PG_MIGRATOR_ROLE
PG_MIGRATOR_ROLE=${PG_MIGRATOR_ROLE:-relayapi_migrator}
read -rp "Worker runtime role [relayapi_runtime]: " PG_RUNTIME_ROLE
PG_RUNTIME_ROLE=${PG_RUNTIME_ROLE:-relayapi_runtime}

valid_identifier "$PG_DB" || die "Database name must be a lowercase PostgreSQL identifier."
valid_identifier "$PG_OWNER_ROLE" || die "Owner role must be a lowercase PostgreSQL identifier."
valid_identifier "$PG_MIGRATOR_ROLE" || die "Migration role must be a lowercase PostgreSQL identifier."
valid_identifier "$PG_RUNTIME_ROLE" || die "Runtime role must be a lowercase PostgreSQL identifier."
[[ "$PG_OWNER_ROLE" != "$PG_MIGRATOR_ROLE" ]] || die "Owner and migration roles must differ."
[[ "$PG_OWNER_ROLE" != "$PG_RUNTIME_ROLE" ]] || die "Owner and runtime roles must differ."
[[ "$PG_MIGRATOR_ROLE" != "$PG_RUNTIME_ROLE" ]] || die "Migration and runtime roles must differ."

read_secret "Migration-role password: " PG_MIGRATOR_PASS
read_secret "Runtime-role password: " PG_RUNTIME_PASS
[[ ${#PG_MIGRATOR_PASS} -ge 20 ]] || die "Migration password must contain at least 20 characters."
[[ ${#PG_RUNTIME_PASS} -ge 20 ]] || die "Runtime password must contain at least 20 characters."

echo
echo "TLS must chain to a CA trusted by Workers VPC and match the VPC service hostname."
echo "A Cloudflare Origin CA or publicly trusted certificate is suitable."
read -rp "Private database TLS hostname (for example db-origin.relayapi.dev): " PG_TLS_HOSTNAME
read -rp "Server certificate path: " PG_TLS_CERT_SOURCE
read -rp "Server private-key path: " PG_TLS_KEY_SOURCE
read -rp "Trusted CA certificate path: " PG_TLS_CA_SOURCE

[[ "$PG_TLS_HOSTNAME" =~ ^[A-Za-z0-9.-]+$ ]] || die "TLS hostname is invalid."
[[ -f "$PG_TLS_CERT_SOURCE" ]] || die "Server certificate was not found."
[[ -f "$PG_TLS_KEY_SOURCE" ]] || die "Server private key was not found."
[[ -f "$PG_TLS_CA_SOURCE" ]] || die "CA certificate was not found."

openssl x509 -in "$PG_TLS_CERT_SOURCE" -noout -checkhost "$PG_TLS_HOSTNAME" >/dev/null 2>&1 || \
	die "Server certificate SAN does not match $PG_TLS_HOSTNAME."
openssl x509 -in "$PG_TLS_CERT_SOURCE" -noout -checkend 2592000 >/dev/null 2>&1 || \
	die "Server certificate expires in less than 30 days."
openssl verify -CAfile "$PG_TLS_CA_SOURCE" "$PG_TLS_CERT_SOURCE" >/dev/null 2>&1 || \
	die "Server certificate does not verify against the supplied CA."

CERT_PUBLIC_KEY=$(openssl x509 -in "$PG_TLS_CERT_SOURCE" -pubkey -noout | \
	openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{print $1}')
PRIVATE_PUBLIC_KEY=$(openssl pkey -in "$PG_TLS_KEY_SOURCE" -pubout -outform DER 2>/dev/null | \
	sha256sum | awk '{print $1}')
[[ -n "$CERT_PUBLIC_KEY" && "$CERT_PUBLIC_KEY" = "$PRIVATE_PUBLIC_KEY" ]] || \
	die "Server certificate and private key do not match."

echo
echo "Cloudflare Tunnel connector token (Workers VPC dashboard -> Tunnels)."
read_secret "Tunnel token: " CF_TUNNEL_TOKEN
[[ -n "$CF_TUNNEL_TOKEN" ]] || die "Tunnel token cannot be empty."

info "Installing system prerequisites"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
	apt-transport-https ca-certificates curl fail2ban gnupg2 jq lsb-release \
	openssh-server postgresql-common sudo ufw unattended-upgrades

mapfile -t SSH_PORTS < <(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' | sort -nu)
if [[ ${#SSH_PORTS[@]} -eq 0 ]]; then
	SSH_PORTS=(22)
	warn "Could not inspect sshd's effective port; preserving port 22."
fi

SSH_KEY_COUNT=0
for authorized_keys in /root/.ssh/authorized_keys "/home/${SUDO_USER:-__none__}/.ssh/authorized_keys"; do
	if [[ -s "$authorized_keys" ]]; then
		SSH_KEY_COUNT=$((SSH_KEY_COUNT + 1))
	fi
done
[[ $SSH_KEY_COUNT -gt 0 ]] || die "No non-empty authorized_keys file was found; refusing to disable SSH passwords."

info "Hardening SSH without changing its listening ports"
install -d -m 0755 /etc/ssh/sshd_config.d
SSH_HARDENING=/etc/ssh/sshd_config.d/99-relayapi-hardening.conf
SSH_HARDENING_TMP=$(mktemp)
cat > "$SSH_HARDENING_TMP" <<'EOF'
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
X11Forwarding no
MaxAuthTries 3
ClientAliveInterval 300
EOF
install -m 0644 "$SSH_HARDENING_TMP" "$SSH_HARDENING"
rm -f "$SSH_HARDENING_TMP"
sshd -t || die "sshd rejected the hardening drop-in; inspect $SSH_HARDENING."
systemctl reload sshd 2>/dev/null || systemctl reload ssh

info "Preserving existing firewall rules and allowing every active SSH port"
ufw default deny incoming
ufw default allow outgoing
for ssh_port in "${SSH_PORTS[@]}"; do
	ufw allow "${ssh_port}/tcp" comment "SSH (RelayAPI preserved)" >/dev/null
done
ufw --force enable >/dev/null
log "UFW enabled; PostgreSQL was not exposed and existing rules were not reset."

SSH_PORT_CSV=$(IFS=,; echo "${SSH_PORTS[*]}")
FAIL2BAN_TMP=$(mktemp)
cat > "$FAIL2BAN_TMP" <<EOF
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port = ${SSH_PORT_CSV}
EOF
install -m 0644 "$FAIL2BAN_TMP" /etc/fail2ban/jail.d/relayapi-sshd.local
rm -f "$FAIL2BAN_TMP"
systemctl enable --now fail2ban >/dev/null

cat > /etc/apt/apt.conf.d/52relayapi-unattended-upgrades <<'EOF'
Unattended-Upgrade::Allowed-Origins {
  "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

info "Installing PostgreSQL 18 from the PGDG repository"
install -d -m 0755 /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
	-o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
cat > /etc/apt/sources.list.d/pgdg.list <<EOF
deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main
EOF
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-18 postgresql-client-18
pg_ctlcluster 18 main start 2>/dev/null || true

PG_CONF=/etc/postgresql/18/main/postgresql.conf
PG_HBA=/etc/postgresql/18/main/pg_hba.conf
PG_SSL_DIR=/etc/postgresql/18/main
PG_SSL_CERT=$PG_SSL_DIR/server.crt
PG_SSL_KEY=$PG_SSL_DIR/server.key

install -o postgres -g postgres -m 0644 "$PG_TLS_CERT_SOURCE" "$PG_SSL_CERT"
install -o postgres -g postgres -m 0600 "$PG_TLS_KEY_SOURCE" "$PG_SSL_KEY"
install -m 0644 "$PG_TLS_CA_SOURCE" /usr/local/share/ca-certificates/relayapi-postgres-ca.crt
update-ca-certificates >/dev/null

if getent hosts "$PG_TLS_HOSTNAME" >/dev/null 2>&1; then
	EXISTING_HOSTS=$(awk -v host="$PG_TLS_HOSTNAME" '$0 !~ /^\s*#/ { for (i = 2; i <= NF; i++) if ($i == host) print $1 }' /etc/hosts)
	if [[ -n "$EXISTING_HOSTS" && "$EXISTING_HOSTS" != "127.0.0.1" ]]; then
		die "$PG_TLS_HOSTNAME already has a non-loopback /etc/hosts mapping; refusing to replace it."
	fi
fi
if ! awk -v host="$PG_TLS_HOSTNAME" '$1 == "127.0.0.1" { for (i = 2; i <= NF; i++) if ($i == host) found = 1 } END { exit !found }' /etc/hosts; then
	printf '127.0.0.1\t%s\t# RelayAPI Workers VPC origin\n' "$PG_TLS_HOSTNAME" >> /etc/hosts
fi

TOTAL_RAM_MB=$(( $(awk '/MemTotal/ { print $2 }' /proc/meminfo) / 1024 ))
CPU_COUNT=$(nproc)
SHARED_BUFFERS_MB=$((TOTAL_RAM_MB / 4))
EFFECTIVE_CACHE_MB=$((TOTAL_RAM_MB * 3 / 4))
MAINTENANCE_WORK_MEM_MB=$((TOTAL_RAM_MB / 16))
[[ $MAINTENANCE_WORK_MEM_MB -gt 1024 ]] && MAINTENANCE_WORK_MEM_MB=1024
[[ $MAINTENANCE_WORK_MEM_MB -lt 64 ]] && MAINTENANCE_WORK_MEM_MB=64
PARALLEL_WORKERS=$((CPU_COUNT / 2))
[[ $PARALLEL_WORKERS -lt 1 ]] && PARALLEL_WORKERS=1

sed -i '/# BEGIN RelayAPI managed settings/,/# END RelayAPI managed settings/d' "$PG_CONF"
cat >> "$PG_CONF" <<EOF

# BEGIN RelayAPI managed settings
listen_addresses = 'localhost'
ssl = on
ssl_cert_file = '${PG_SSL_CERT}'
ssl_key_file = '${PG_SSL_KEY}'
password_encryption = 'scram-sha-256'
max_connections = 100
shared_buffers = ${SHARED_BUFFERS_MB}MB
effective_cache_size = ${EFFECTIVE_CACHE_MB}MB
maintenance_work_mem = ${MAINTENANCE_WORK_MEM_MB}MB
work_mem = 4MB
checkpoint_completion_target = 0.9
wal_buffers = 16MB
default_statistics_target = 100
random_page_cost = 1.1
effective_io_concurrency = 200
min_wal_size = 1GB
max_wal_size = 4GB
max_worker_processes = ${CPU_COUNT}
max_parallel_workers_per_gather = ${PARALLEL_WORKERS}
max_parallel_workers = ${CPU_COUNT}
log_min_duration_statement = 1000
log_checkpoints = on
# END RelayAPI managed settings
EOF

cp "$PG_HBA" "${PG_HBA}.pre-relayapi.$(date +%s)"
cat > "$PG_HBA" <<EOF
# RelayAPI PostgreSQL origin. The VPC hostname resolves to loopback on this host.
# TYPE     DATABASE  USER                 ADDRESS          METHOD
local      all       postgres                              peer
local      all       all                                   scram-sha-256
host       all       postgres             127.0.0.1/32     scram-sha-256
host       all       postgres             ::1/128          scram-sha-256
hostssl    ${PG_DB}  ${PG_RUNTIME_ROLE}   127.0.0.1/32     scram-sha-256
hostssl    ${PG_DB}  ${PG_RUNTIME_ROLE}   ::1/128          scram-sha-256
hostssl    ${PG_DB}  ${PG_MIGRATOR_ROLE}  127.0.0.1/32     scram-sha-256
hostssl    ${PG_DB}  ${PG_MIGRATOR_ROLE}  ::1/128          scram-sha-256
host       all       all                  0.0.0.0/0        reject
host       all       all                  ::0/0            reject
EOF
chown postgres:postgres "$PG_HBA"
chmod 0600 "$PG_HBA"
systemctl restart postgresql

info "Creating separated database roles"
sudo -u postgres psql --set=ON_ERROR_STOP=1 \
	--set=db_name="$PG_DB" \
	--set=owner_role="$PG_OWNER_ROLE" \
	--set=migrator_role="$PG_MIGRATOR_ROLE" \
	--set=migrator_password="$PG_MIGRATOR_PASS" \
	--set=runtime_role="$PG_RUNTIME_ROLE" \
	--set=runtime_password="$PG_RUNTIME_PASS" <<'SQL'
SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'owner_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner_role') \gexec

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'migrator_role', :'migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migrator_role') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'migrator_role', :'migrator_password') \gexec

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'runtime_role', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'runtime_role') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'runtime_role', :'runtime_password') \gexec

SELECT format('GRANT %I TO %I', :'owner_role', :'migrator_role') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db_name', :'owner_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db_name', :'owner_role') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
SELECT format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO %I', :'db_name', :'migrator_role') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'runtime_role') \gexec
SQL

sudo -u postgres psql --set=ON_ERROR_STOP=1 --dbname="$PG_DB" \
	--set=owner_role="$PG_OWNER_ROLE" \
	--set=migrator_role="$PG_MIGRATOR_ROLE" \
	--set=runtime_role="$PG_RUNTIME_ROLE" <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('ALTER SCHEMA public OWNER TO %I', :'owner_role') \gexec
CREATE SCHEMA IF NOT EXISTS auth;
SELECT format('ALTER SCHEMA auth OWNER TO %I', :'owner_role') \gexec

SELECT format('GRANT USAGE, CREATE ON SCHEMA public, auth TO %I', :'migrator_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public, auth TO %I', :'runtime_role') \gexec

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'migrator_role', :'runtime_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA auth GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'migrator_role', :'runtime_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', :'migrator_role', :'runtime_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA auth GRANT USAGE, SELECT ON SEQUENCES TO %I', :'migrator_role', :'runtime_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I', :'migrator_role', :'runtime_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA auth GRANT EXECUTE ON FUNCTIONS TO %I', :'migrator_role', :'runtime_role') \gexec

SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, auth TO %I', :'runtime_role') \gexec
SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public, auth TO %I', :'runtime_role') \gexec
SELECT format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, auth TO %I', :'runtime_role') \gexec

SELECT format('ALTER ROLE %I IN DATABASE %I SET statement_timeout = %L', :'runtime_role', current_database(), '55s') \gexec
SELECT format('ALTER ROLE %I IN DATABASE %I SET idle_in_transaction_session_timeout = %L', :'runtime_role', current_database(), '30s') \gexec
SQL

PGPASSWORD="$PG_RUNTIME_PASS" PGSSLROOTCERT="$PG_TLS_CA_SOURCE" \
	psql "host=$PG_TLS_HOSTNAME port=5432 dbname=$PG_DB user=$PG_RUNTIME_ROLE sslmode=verify-full" \
	-c 'SELECT current_database(), current_user;' >/dev/null
log "Runtime TLS connection verified with hostname and CA validation."

info "Installing the Cloudflare Tunnel connector"
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
	-o /usr/share/keyrings/cloudflare-main.gpg
cat > /etc/apt/sources.list.d/cloudflared.list <<EOF
deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared ${CODENAME} main
EOF
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cloudflared

if systemctl cat cloudflared >/dev/null 2>&1; then
	warn "An existing cloudflared service was preserved. Rotate its token separately if needed."
else
	cloudflared service install "$CF_TUNNEL_TOKEN"
fi
systemctl enable --now cloudflared >/dev/null
systemctl is-active --quiet cloudflared || die "cloudflared failed to start; inspect journalctl -u cloudflared."

PG_VERSION=$(sudo -u postgres psql -Atqc 'SHOW server_version;')
[[ "$PG_VERSION" == 18.* ]] || die "Expected PostgreSQL 18, found $PG_VERSION."

echo
echo -e "${GREEN}PostgreSQL origin is ready.${NC}"
echo
echo "Database:        $PG_DB"
echo "TLS/VPC host:    $PG_TLS_HOSTNAME (loopback only on the origin)"
echo "Owner role:      $PG_OWNER_ROLE (NOLOGIN)"
echo "Migration role:  $PG_MIGRATOR_ROLE (DDL)"
echo "Runtime role:    $PG_RUNTIME_ROLE (no DDL)"
echo "SSH ports kept:  $SSH_PORT_CSV"
echo
echo "Create the preferred Workers VPC service from a trusted workstation:"
echo "  npx wrangler vpc service create relayapi-postgres \\"
echo "    --type tcp --tcp-port 5432 --app-protocol postgresql \\"
echo "    --tunnel-id <TUNNEL_ID> --hostname $PG_TLS_HOSTNAME \\"
echo "    --cert-verification-mode verify_full"
echo
echo "Then create Hyperdrive with the no-DDL runtime role:"
echo "  npx wrangler hyperdrive create relayapi-db \\"
echo "    --service-id <VPC_SERVICE_ID> --database $PG_DB \\"
echo "    --user $PG_RUNTIME_ROLE --password '<runtime-password>' --scheme postgresql"
echo
echo "For GitHub migrations, configure a separate Cloudflare Access TCP application"
echo "with a Service Auth policy and route it to tcp://localhost:5432. Store only the"
echo "migration-role DSN and Access service-token credentials in the production"
echo "environment. Never reuse the Worker runtime role for migrations."
echo
echo "External backups and restore rehearsals are intentionally not installed here."
echo "Operate and verify them independently before storing production data."
