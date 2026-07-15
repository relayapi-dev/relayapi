#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GITLEAKS_BIN="${GITLEAKS_BIN:-gitleaks}"

command -v "$GITLEAKS_BIN" >/dev/null 2>&1 || {
	printf '%s\n' 'error: gitleaks is required for the secret-scan regression test' >&2
	exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT HUP INT TERM

# Assemble the fixture at runtime so a credential-shaped string is never
# committed merely to test the scanner. The values are synthetic.
fixture_password="relayapi_secret_scan_fixture"
mkdir -p "$tmp/unsafe/.github/workflows" "$tmp/safe/.github/workflows"
printf '%s%s%s\n' \
	'postgresql://fixture_user:' \
	"$fixture_password" \
	'@db.invalid:5432/fixture' >"$tmp/unsafe/.github/workflows/deploy-api.yml"

# The prior configuration trusted this whole workflow path. It must now catch
# an unknown credential there while retaining the exact mock fixture.
printf '%s%s%s\n' \
	'postgresql://mock:' \
	'mock' \
	'@localhost:5432/mock' >"$tmp/safe/.github/workflows/deploy-api.yml"

set +e
output="$($GITLEAKS_BIN dir --no-banner --redact=100 \
	--config "$ROOT/.gitleaks.toml" "$tmp/unsafe" 2>&1)"
status=$?
set -e

if [ "$status" -eq 0 ]; then
	printf '%s\n' 'error: credential-bearing database URL fixture was not detected' >&2
	exit 1
fi
if printf '%s' "$output" | grep -Fq "$fixture_password"; then
	printf '%s\n' 'error: secret-scan output was not fully redacted' >&2
	exit 1
fi

if ! $GITLEAKS_BIN dir --no-banner --redact=100 \
	--config "$ROOT/.gitleaks.toml" "$tmp/safe" >/dev/null 2>&1; then
	printf '%s\n' 'error: exact synthetic database fixture was not allowlisted' >&2
	exit 1
fi

printf '%s\n' 'credentialed database URL detection, redaction, and exact-fixture policy passed'
