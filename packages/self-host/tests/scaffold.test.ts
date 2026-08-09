import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEncryptionKeyRing } from "../src/doctor.js";
import {
	generatedSecrets,
	prepareInitDirectory,
	writeScaffold,
} from "../src/scaffold.js";

describe("operator repository scaffold", () => {
	test("pins generated deployments to the supported Bun runtime", async () => {
		const directory = await mkdtemp(join(tmpdir(), "relayapi-self-host-"));
		try {
			await writeScaffold(join(directory, "relayapi.config.json"));
			const workflow = await readFile(
				join(directory, ".github", "workflows", "deploy-relayapi.yml"),
				"utf8",
			);

			expect(workflow).toContain('bun-version: "1.3.14"');
			expect(workflow).not.toContain('bun-version: "1.2.19"');
			expect(workflow).toContain("RELAYAPI_MIGRATION_DATABASE_URL");
			expect(workflow).not.toContain("RELAYAPI_DATABASE_URL");
			expect(workflow).toContain("sourceArchiveSha256");
			expect(workflow).not.toContain("([-.][0-9A-Za-z.-]+)?");
			const updater = await readFile(
				join(directory, ".github", "workflows", "update-relayapi.yml"),
				"utf8",
			);
			expect(updater).toContain("upgrade --non-interactive");
			expect(updater).not.toContain("sort -V");
			const environmentExample = await readFile(
				join(directory, ".env.example"),
				"utf8",
			);
			expect(environmentExample).toContain(
				"ENCRYPTION_KEY=active=<64-hex-characters>,identity=<retained-64-hex-characters>",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("merges existing gitignore rules without requiring force", async () => {
		const directory = await mkdtemp(join(tmpdir(), "relayapi-self-host-"));
		const configPath = join(directory, "relayapi.selfhost.json");
		try {
			await writeFile(join(directory, ".gitignore"), "operator-owned-entry\n");
			const preparation = await prepareInitDirectory(configPath, {
				force: false,
			});
			expect(preparation).toEqual({
				overwrite: false,
				mergeGitignore: true,
			});
			await writeScaffold(configPath, preparation);
			const gitignore = await readFile(join(directory, ".gitignore"), "utf8");
			expect(gitignore).toContain("operator-owned-entry");
			expect(gitignore).toContain(".relayapi/backups/");
			expect(gitignore.match(/operator-owned-entry/g)).toHaveLength(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("refuses --github init in an existing Git repository even with force", async () => {
		const directory = await mkdtemp(join(tmpdir(), "relayapi-self-host-"));
		try {
			await mkdir(join(directory, ".git"));
			await expect(
				prepareInitDirectory(join(directory, "relayapi.selfhost.json"), {
					force: true,
					github: true,
				}),
			).rejects.toThrow("an existing .git path was found");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("requires an empty --github target without restricting local init", async () => {
		const directory = await mkdtemp(join(tmpdir(), "relayapi-self-host-"));
		const configPath = join(directory, "relayapi.selfhost.json");
		try {
			await writeFile(join(directory, "operator-notes.md"), "keep me\n");
			await expect(
				prepareInitDirectory(configPath, { force: true, github: true }),
			).rejects.toThrow("contains operator-notes.md");

			const preparation = await prepareInitDirectory(configPath, {
				force: false,
			});
			expect(preparation).toEqual({
				overwrite: false,
				mergeGitignore: false,
			});
			await writeScaffold(configPath, preparation);
			expect(await readFile(join(directory, "operator-notes.md"), "utf8")).toBe(
				"keep me\n",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("refuses managed-file collisions and backs them up before force", async () => {
		const directory = await mkdtemp(join(tmpdir(), "relayapi-self-host-"));
		const configPath = join(directory, "relayapi.selfhost.json");
		try {
			await writeFile(join(directory, ".env.example"), "operator=value\n");
			await expect(
				prepareInitDirectory(configPath, { force: false }),
			).rejects.toThrow("rerun with --force");
			const preparation = await prepareInitDirectory(configPath, {
				force: true,
			});
			expect(preparation.overwrite).toBe(true);
			expect(
				await readFile(
					join(preparation.backupDirectory ?? "", ".env.example"),
					"utf8",
				),
			).toBe("operator=value\n");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rejects symlinked managed directories", async () => {
		const directory = await mkdtemp(join(tmpdir(), "relayapi-self-host-"));
		const outside = await mkdtemp(
			join(tmpdir(), "relayapi-self-host-outside-"),
		);
		try {
			await mkdir(join(directory, ".github"));
			await symlink(outside, join(directory, ".github", "workflows"));
			await expect(
				prepareInitDirectory(join(directory, "relayapi.selfhost.json"), {
					force: true,
				}),
			).rejects.toThrow("non-directory init target .github/workflows");
		} finally {
			await rm(directory, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	test("generates distinct active and retained identity key material", () => {
		const { encryptionKey } = generatedSecrets();
		expect(() => validateEncryptionKeyRing(encryptionKey)).not.toThrow();
		const entries = new Map(
			encryptionKey
				.split(",")
				.map((entry) => entry.split("=") as [string, string]),
		);
		expect(entries.get("active")).toHaveLength(64);
		expect(entries.get("identity")).toHaveLength(64);
		expect(entries.get("active")).not.toBe(entries.get("identity"));
	});
});
