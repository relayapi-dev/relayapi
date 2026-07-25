import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CONFIG_FILENAME, LOCK_FILENAME } from "./constants.js";
import { run } from "./process.js";
import type { SelfHostConfig } from "./types.js";

const checkoutAction =
	"actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5";
const setupBunAction =
	"oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";

function deployWorkflow(): string {
	return `name: Deploy RelayAPI

on:
  push:
    branches: [main]
    paths:
      - "${CONFIG_FILENAME}"
      - "${LOCK_FILENAME}"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: relayapi-self-host-production
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    timeout-minutes: 45
    steps:
      - uses: ${checkoutAction} # v4.3.1
        with:
          persist-credentials: false
      - uses: ${setupBunAction} # v2.2.0
        with:
          bun-version: "1.3.14"
      - name: Deploy reviewed RelayAPI release
        shell: bash
        env:
${githubSecretNames.map((name) => `          ${name}: \${{ secrets.${name} }}`).join("\n")}
        run: |
          set -euo pipefail
          version="$(jq -er '.version | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+([-.][0-9A-Za-z.-]+)?$"))' ${LOCK_FILENAME})"
          bunx "@relayapi/self-host@\${version}" doctor --non-interactive
          bunx "@relayapi/self-host@\${version}" deploy --non-interactive
`;
}

function updateWorkflow(): string {
	return `name: Check for RelayAPI updates

on:
  schedule:
    - cron: "17 7 * * *"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  update:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: ${checkoutAction} # v4.3.1
        with:
          persist-credentials: true
      - name: Resolve latest stable self-host release
        id: release
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          repository="$(jq -er '.sourceRepository' ${LOCK_FILENAME})"
          current="$(jq -er '.version' ${LOCK_FILENAME})"
          latest="$(gh api --paginate "repos/\${repository}/releases?per_page=100" --jq '.[] | select(.draft == false and .prerelease == false and (.tag_name | test("^self-host-v[0-9]+[.][0-9]+[.][0-9]+$"))) | .tag_name' | sed 's/^self-host-v//' | sort -V | tail -n 1)"
          test -n "\${latest}"
          if [ "\${latest}" = "\${current}" ]; then
            echo "changed=false" >> "\${GITHUB_OUTPUT}"
            exit 0
          fi
          jq --arg version "\${latest}" --arg updatedAt "$(date -u +%FT%TZ)" '.version = $version | .updatedAt = $updatedAt' ${LOCK_FILENAME} > ${LOCK_FILENAME}.tmp
          mv ${LOCK_FILENAME}.tmp ${LOCK_FILENAME}
          echo "changed=true" >> "\${GITHUB_OUTPUT}"
          echo "version=\${latest}" >> "\${GITHUB_OUTPUT}"
      - name: Open update pull request
        if: steps.release.outputs.changed == 'true'
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
          VERSION: \${{ steps.release.outputs.version }}
        run: |
          set -euo pipefail
          branch="relayapi/update-\${VERSION}"
          if [ "$(gh pr list --head "\${branch}" --state open --json number --jq 'length')" != "0" ]; then
            echo "An update pull request for \${VERSION} is already open."
            exit 0
          fi
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git checkout -b "\${branch}"
          git add ${LOCK_FILENAME}
          git commit -m "chore(self-host): update RelayAPI to \${VERSION}"
          git push --force-with-lease origin "\${branch}"
          gh pr create --base main --head "\${branch}" --title "Update RelayAPI to \${VERSION}" --body "Updates the reviewed self-host release lock. Merging this PR runs the guarded production deployment workflow."
`;
}

export async function writeScaffold(configPath: string): Promise<void> {
	const root = dirname(resolve(configPath));
	const workflowDir = resolve(root, ".github", "workflows");
	await mkdir(workflowDir, { recursive: true });
	await mkdir(resolve(root, ".relayapi"), { recursive: true, mode: 0o700 });
	await Promise.all([
		writeFile(resolve(workflowDir, "deploy-relayapi.yml"), deployWorkflow(), {
			mode: 0o600,
		}),
		writeFile(resolve(workflowDir, "update-relayapi.yml"), updateWorkflow(), {
			mode: 0o600,
		}),
		writeFile(
			resolve(root, ".gitignore"),
			".relayapi/generated/\n.relayapi/secrets.env\n",
			{ mode: 0o600 },
		),
		writeFile(
			resolve(root, ".env.example"),
			`${[
				"CLOUDFLARE_API_TOKEN=",
				"CLOUDFLARE_ACCOUNT_ID=",
				"RELAYAPI_DATABASE_URL=<tls-postgresql-url-for-migration-role>",
				"RELAYAPI_RUNTIME_DATABASE_URL=<tls-postgresql-url-for-runtime-role>",
				"RELAYAPI_ADMIN_EMAIL=admin@example.com",
				"RELAYAPI_ADMIN_PASSWORD=<random-12+-character-password>",
				"ENCRYPTION_KEY=active=<64-hex-characters>",
				"BETTER_AUTH_SECRET=<random-secret>",
				"R2_ACCESS_KEY_ID=",
				"R2_SECRET_ACCESS_KEY=",
				"# RESEND_API_KEY=",
				"# GOOGLE_CLIENT_ID=",
				"# GOOGLE_CLIENT_SECRET=",
				"# TWITTER_CLIENT_ID=",
				"# TWITTER_CLIENT_SECRET=",
				"# FACEBOOK_APP_ID=",
				"# FACEBOOK_APP_SECRET=",
				"# INSTAGRAM_APP_ID=",
				"# INSTAGRAM_APP_SECRET=",
				"# INSTAGRAM_LOGIN_APP_ID=",
				"# INSTAGRAM_LOGIN_APP_SECRET=",
				"# LINKEDIN_CLIENT_ID=",
				"# LINKEDIN_CLIENT_SECRET=",
				"# TIKTOK_CLIENT_KEY=",
				"# TIKTOK_CLIENT_SECRET=",
				"# YOUTUBE_CLIENT_ID=",
				"# YOUTUBE_CLIENT_SECRET=",
				"# PINTEREST_APP_ID=",
				"# PINTEREST_APP_SECRET=",
				"# REDDIT_CLIENT_ID=",
				"# REDDIT_CLIENT_SECRET=",
				"# THREADS_APP_ID=",
				"# THREADS_APP_SECRET=",
				"# SNAPCHAT_CLIENT_ID=",
				"# SNAPCHAT_CLIENT_SECRET=",
				"# WHATSAPP_APP_ID=",
				"# WHATSAPP_APP_SECRET=",
				"# WHATSAPP_CONFIG_ID=",
				"# MASTODON_CLIENT_ID=",
				"# MASTODON_CLIENT_SECRET=",
				"# TELEGRAM_BOT_TOKEN=",
				"# TELEGRAM_WEBHOOK_SECRET=",
				"# FACEBOOK_WEBHOOK_VERIFY_TOKEN=",
				"# YOUTUBE_HUB_SECRET=",
			].join("\n")}\n`,
			{ mode: 0o600 },
		),
	]);
}

const githubSecretNames = [
	"CLOUDFLARE_API_TOKEN",
	"CLOUDFLARE_ACCOUNT_ID",
	"RELAYAPI_DATABASE_URL",
	"RELAYAPI_RUNTIME_DATABASE_URL",
	"RELAYAPI_ADMIN_EMAIL",
	"RELAYAPI_ADMIN_PASSWORD",
	"ENCRYPTION_KEY",
	"BETTER_AUTH_SECRET",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
	"RESEND_API_KEY",
	"DOWNLOADER_SERVICE_URL",
	"DOWNLOADER_SERVICE_KEY",
	"GOOGLE_CLIENT_ID",
	"GOOGLE_CLIENT_SECRET",
	"TWITTER_CLIENT_ID",
	"TWITTER_CLIENT_SECRET",
	"FACEBOOK_APP_ID",
	"FACEBOOK_APP_SECRET",
	"INSTAGRAM_APP_ID",
	"INSTAGRAM_APP_SECRET",
	"INSTAGRAM_LOGIN_APP_ID",
	"INSTAGRAM_LOGIN_APP_SECRET",
	"LINKEDIN_CLIENT_ID",
	"LINKEDIN_CLIENT_SECRET",
	"TIKTOK_CLIENT_KEY",
	"TIKTOK_CLIENT_SECRET",
	"YOUTUBE_CLIENT_ID",
	"YOUTUBE_CLIENT_SECRET",
	"PINTEREST_APP_ID",
	"PINTEREST_APP_SECRET",
	"REDDIT_CLIENT_ID",
	"REDDIT_CLIENT_SECRET",
	"THREADS_APP_ID",
	"THREADS_APP_SECRET",
	"SNAPCHAT_CLIENT_ID",
	"SNAPCHAT_CLIENT_SECRET",
	"WHATSAPP_APP_ID",
	"WHATSAPP_APP_SECRET",
	"WHATSAPP_CONFIG_ID",
	"MASTODON_CLIENT_ID",
	"MASTODON_CLIENT_SECRET",
	"TELEGRAM_BOT_TOKEN",
	"TELEGRAM_WEBHOOK_SECRET",
	"FACEBOOK_WEBHOOK_VERIFY_TOKEN",
	"YOUTUBE_HUB_SECRET",
] as const;

export async function configureGithubRepository(
	config: SelfHostConfig,
	configPath: string,
): Promise<void> {
	if (!config.github) return;
	const root = dirname(resolve(configPath));
	await run("gh", ["repo", "create", config.github.repository, "--private"], {
		cwd: root,
	});
	for (const name of githubSecretNames) {
		const value = process.env[name];
		if (!value) continue;
		await run(
			"gh",
			["secret", "set", name, "--repo", config.github.repository],
			{ cwd: root, stdin: value },
		);
	}
	await run("git", ["init", "--initial-branch=main"], { cwd: root });
	await run(
		"git",
		[
			"add",
			CONFIG_FILENAME,
			LOCK_FILENAME,
			".github",
			".gitignore",
			".env.example",
		],
		{
			cwd: root,
		},
	);
	await run("git", ["commit", "-m", "chore: configure RelayAPI self-hosting"], {
		cwd: root,
	});
	await run(
		"git",
		[
			"remote",
			"add",
			"origin",
			`https://github.com/${config.github.repository}.git`,
		],
		{ cwd: root },
	);
	await run("git", ["push", "--set-upstream", "origin", "main"], {
		cwd: root,
	});
}

export function generatedSecrets(): {
	encryptionKey: string;
	betterAuthSecret: string;
	adminPassword: string;
} {
	return {
		encryptionKey: `active=${randomBytes(32).toString("hex")}`,
		betterAuthSecret: randomBytes(32).toString("base64url"),
		adminPassword: randomBytes(24).toString("base64url"),
	};
}
