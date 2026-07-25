import { CloudflareClient, parsePostgresUrl } from "./cloudflare.js";
import { readConfig, readLock } from "./config.js";
import { commandExists } from "./process.js";
import type { CliOptions } from "./types.js";

export async function doctor(options: CliOptions): Promise<void> {
	const checks: Array<[string, () => Promise<void>]> = [
		[
			"configuration",
			async () => {
				await readConfig(options.configPath);
				await readLock(options.configPath);
			},
		],
		[
			"Bun",
			async () => {
				if (!(await commandExists("bun")))
					throw new Error("bun is not installed");
			},
		],
		[
			"tar",
			async () => {
				if (!(await commandExists("tar")))
					throw new Error("tar is not installed");
			},
		],
		[
			"database URLs",
			async () => {
				const migration = parsePostgresUrl(required("RELAYAPI_DATABASE_URL"));
				const runtime = parsePostgresUrl(
					required("RELAYAPI_RUNTIME_DATABASE_URL"),
				);
				if (migration.username === runtime.username) {
					throw new Error(
						"Migration and runtime database URLs must use different roles",
					);
				}
			},
		],
		[
			"deployment secrets",
			async () => {
				const config = await readConfig(options.configPath);
				for (const name of [
					"ENCRYPTION_KEY",
					"BETTER_AUTH_SECRET",
					"R2_ACCESS_KEY_ID",
					"R2_SECRET_ACCESS_KEY",
					"RELAYAPI_ADMIN_EMAIL",
					"RELAYAPI_ADMIN_PASSWORD",
				]) {
					required(name);
				}
				if (
					!/^([A-Za-z0-9_-]+)=[a-fA-F0-9]{64}$/.test(required("ENCRYPTION_KEY"))
				) {
					throw new Error("ENCRYPTION_KEY must use key-id=64hex format");
				}
				if (required("RELAYAPI_ADMIN_PASSWORD").length < 12) {
					throw new Error(
						"RELAYAPI_ADMIN_PASSWORD must contain at least 12 characters",
					);
				}
				if (config.features.email) required("RESEND_API_KEY");
				if (config.features.downloader) {
					required("DOWNLOADER_SERVICE_URL");
					required("DOWNLOADER_SERVICE_KEY");
				}
			},
		],
		[
			"Cloudflare access",
			async () => {
				const config = await readConfig(options.configPath);
				const accountId = required("CLOUDFLARE_ACCOUNT_ID");
				if (config.cloudflare.accountId !== accountId) {
					throw new Error("Cloudflare account ID does not match the config");
				}
				const client = new CloudflareClient(
					accountId,
					required("CLOUDFLARE_API_TOKEN"),
				);
				await client.verifyAccess(config.cloudflare.zoneId);
				await client.plan();
			},
		],
	];

	for (const [name, check] of checks) {
		try {
			await check();
			console.log(`✓ ${name}`);
		} catch (error) {
			console.error(
				`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`missing ${name}`);
	return value;
}
