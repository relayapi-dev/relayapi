import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
          version="$(jq -er '.version | select(test("^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$"))' ${LOCK_FILENAME})"
          jq -er '.sourceArchiveSha256 | select(test("^[a-f0-9]{64}$"))' ${LOCK_FILENAME} >/dev/null
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
          current="$(jq -er '.version | select(test("^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$"))' ${LOCK_FILENAME})"
          before="$(sha256sum ${LOCK_FILENAME} | cut -d ' ' -f 1)"
          bunx "@relayapi/self-host@\${current}" upgrade --non-interactive
          after="$(sha256sum ${LOCK_FILENAME} | cut -d ' ' -f 1)"
          if [ "\${before}" = "\${after}" ]; then
            echo "changed=false" >> "\${GITHUB_OUTPUT}"
            exit 0
          fi
          latest="$(jq -er '.version' ${LOCK_FILENAME})"
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

interface InitPreparation {
	overwrite: boolean;
	mergeGitignore: boolean;
	backupDirectory?: string;
}

function initManagedPaths(configPath: string): string[] {
	const root = dirname(resolve(configPath));
	const workflowDir = resolve(root, ".github", "workflows");
	return [
		resolve(configPath),
		resolve(root, LOCK_FILENAME),
		resolve(workflowDir, "deploy-relayapi.yml"),
		resolve(workflowDir, "update-relayapi.yml"),
		resolve(root, ".env.example"),
		resolve(root, ".relayapi", "secrets.env"),
	];
}

async function pathKind(
	path: string,
	expected: "file" | "directory",
	root: string,
): Promise<boolean> {
	try {
		const stats = await lstat(path);
		const matches = expected === "file" ? stats.isFile() : stats.isDirectory();
		if (!matches) {
			throw new Error(
				`Refusing to use non-${expected} init target ${relative(root, path)}`,
			);
		}
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function assertSafeManagedDirectories(root: string): Promise<void> {
	for (const path of [
		resolve(root, ".github"),
		resolve(root, ".github", "workflows"),
		resolve(root, ".relayapi"),
		resolve(root, ".relayapi", "backups"),
	]) {
		await pathKind(path, "directory", root);
	}
}

async function assertEmptyGithubInitTarget(root: string): Promise<void> {
	let rootStats: Stats;
	try {
		rootStats = await lstat(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!rootStats.isDirectory()) {
		throw new Error(
			`--github requires a new empty target directory, but ${root} is not a directory`,
		);
	}

	const entries = (await readdir(root)).sort();
	if (entries.includes(".git")) {
		throw new Error(
			`Refusing --github init in ${root}: an existing .git path was found. Use a new empty directory, or omit --github to keep this repository's Git history untouched`,
		);
	}
	if (entries.length > 0) {
		const displayedEntries = entries.slice(0, 5).join(", ");
		const suffix = entries.length > 5 ? ", ..." : "";
		throw new Error(
			`--github requires a new empty target directory, but ${root} contains ${displayedEntries}${suffix}. Use a new empty directory, or omit --github for collision-safe local initialization without Git changes`,
		);
	}
}

export async function prepareInitDirectory(
	configPath: string,
	options: { force: boolean; github?: boolean },
): Promise<InitPreparation> {
	const root = dirname(resolve(configPath));
	if (options.github) await assertEmptyGithubInitTarget(root);
	await assertSafeManagedDirectories(root);
	const existing: string[] = [];
	for (const path of initManagedPaths(configPath)) {
		if (await pathKind(path, "file", root)) existing.push(path);
	}
	const gitignorePath = resolve(root, ".gitignore");
	const mergeGitignore = await pathKind(gitignorePath, "file", root);
	if (existing.length === 0) {
		return { overwrite: false, mergeGitignore };
	}
	if (!options.force) {
		throw new Error(
			`init would replace existing files: ${existing.map((path) => relative(root, path)).join(", ")}; rerun with --force to back them up before replacement`,
		);
	}

	const backupRoot = resolve(root, ".relayapi", "backups");
	await mkdir(backupRoot, { recursive: true, mode: 0o700 });
	const backupDirectory = await mkdtemp(resolve(backupRoot, "init-"));
	for (const source of [
		...existing,
		...(mergeGitignore ? [gitignorePath] : []),
	]) {
		const relativePath = relative(root, source);
		const destination = resolve(backupDirectory, relativePath);
		const destinationRelative = relative(backupDirectory, destination);
		if (
			destinationRelative.startsWith("..") ||
			isAbsolute(destinationRelative)
		) {
			throw new Error("Init backup target escaped the operator repository");
		}
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
		await copyFile(source, destination, constants.COPYFILE_EXCL);
	}
	return { overwrite: true, mergeGitignore, backupDirectory };
}

const REQUIRED_GITIGNORE_ENTRIES = [
	".relayapi/generated/",
	".relayapi/secrets.env",
	".relayapi/backups/",
] as const;

function mergeGitignore(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n");
	const existing = new Set(normalized.split("\n"));
	const missing = REQUIRED_GITIGNORE_ENTRIES.filter(
		(entry) => !existing.has(entry),
	);
	if (missing.length === 0) {
		return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
	}
	const prefix =
		normalized.length === 0 ? "" : normalized.replace(/\n*$/, "\n");
	return `${prefix}${missing.join("\n")}\n`;
}

export async function writeScaffold(
	configPath: string,
	options: { overwrite?: boolean; mergeGitignore?: boolean } = {},
): Promise<void> {
	const root = dirname(resolve(configPath));
	await assertSafeManagedDirectories(root);
	const workflowDir = resolve(root, ".github", "workflows");
	await mkdir(workflowDir, { recursive: true });
	await mkdir(resolve(root, ".relayapi"), { recursive: true, mode: 0o700 });
	const flag = options.overwrite ? "w" : "wx";
	const gitignorePath = resolve(root, ".gitignore");
	const gitignore = options.mergeGitignore
		? mergeGitignore(await readFile(gitignorePath, "utf8"))
		: `${REQUIRED_GITIGNORE_ENTRIES.join("\n")}\n`;
	await Promise.all([
		writeFile(resolve(workflowDir, "deploy-relayapi.yml"), deployWorkflow(), {
			mode: 0o600,
			flag,
		}),
		writeFile(resolve(workflowDir, "update-relayapi.yml"), updateWorkflow(), {
			mode: 0o600,
			flag,
		}),
		writeFile(gitignorePath, gitignore, {
			mode: 0o600,
			flag: options.mergeGitignore ? "w" : flag,
		}),
		writeFile(
			resolve(root, ".env.example"),
			`${[
				"CLOUDFLARE_API_TOKEN=",
				"CLOUDFLARE_ACCOUNT_ID=",
				"RELAYAPI_MIGRATION_DATABASE_URL=postgresql://migration-role:password@db.example.com:5432/relayapi?sslmode=verify-full",
				"RELAYAPI_RUNTIME_DATABASE_URL=<tls-postgresql-url-for-runtime-role>",
				"RELAYAPI_ADMIN_EMAIL=admin@example.com",
				"RELAYAPI_ADMIN_PASSWORD=<random-12+-character-password>",
				"ENCRYPTION_KEY=active=<64-hex-characters>,identity=<retained-64-hex-characters>",
				"BETTER_AUTH_SECRET=<random-secret>",
				"R2_ACCESS_KEY_ID=",
				"R2_SECRET_ACCESS_KEY=",
				"# OPENAI_API_KEY=",
				"# RESEND_API_KEY=",
				"# OPERATIONS_ALERT_WEBHOOK_URL=https://alerts.example.com/relayapi",
				"# OPERATIONS_ALERT_EMAIL=alerts@example.com",
				"# GOOGLE_CLIENT_ID=",
				"# GOOGLE_CLIENT_SECRET=",
				"# GOOGLE_ADS_DEVELOPER_TOKEN=",
				"# TWITTER_CLIENT_ID=",
				"# TWITTER_CLIENT_SECRET=",
				"# TWITTER_ADS_CONSUMER_KEY=",
				"# TWITTER_ADS_CONSUMER_SECRET=",
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
				"# TIKTOK_ADS_APP_ID=",
				"# TIKTOK_ADS_APP_SECRET=",
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
			{ mode: 0o600, flag },
		),
	]);
	await Promise.all([
		chmod(resolve(workflowDir, "deploy-relayapi.yml"), 0o600),
		chmod(resolve(workflowDir, "update-relayapi.yml"), 0o600),
		chmod(resolve(root, ".env.example"), 0o600),
	]);
}

const githubSecretNames = [
	"CLOUDFLARE_API_TOKEN",
	"CLOUDFLARE_ACCOUNT_ID",
	"RELAYAPI_MIGRATION_DATABASE_URL",
	"RELAYAPI_RUNTIME_DATABASE_URL",
	"RELAYAPI_ADMIN_EMAIL",
	"RELAYAPI_ADMIN_PASSWORD",
	"ENCRYPTION_KEY",
	"BETTER_AUTH_SECRET",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
	"OPENAI_API_KEY",
	"RESEND_API_KEY",
	"DOWNLOADER_SERVICE_URL",
	"DOWNLOADER_SERVICE_KEY",
	"GOOGLE_CLIENT_ID",
	"GOOGLE_CLIENT_SECRET",
	"GOOGLE_ADS_DEVELOPER_TOKEN",
	"TWITTER_CLIENT_ID",
	"TWITTER_CLIENT_SECRET",
	"TWITTER_ADS_CONSUMER_KEY",
	"TWITTER_ADS_CONSUMER_SECRET",
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
	"TIKTOK_ADS_APP_ID",
	"TIKTOK_ADS_APP_SECRET",
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
		encryptionKey: `active=${randomBytes(32).toString("hex")},identity=${randomBytes(32).toString("hex")}`,
		betterAuthSecret: randomBytes(32).toString("base64url"),
		adminPassword: randomBytes(24).toString("base64url"),
	};
}
