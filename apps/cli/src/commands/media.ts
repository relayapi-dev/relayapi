import { Command } from "commander";
import { basename } from "node:path";
import * as prompts from "@clack/prompts";
import { createClient } from "../client.js";
import {
	isTableMode,
	outputJson,
	outputSuccess,
	outputTable,
	truncate,
	withErrorHandler,
} from "../output.js";

export function registerMediaCommands(program: Command): void {
	const media = program
		.command("media")
		.description("Manage media files")
		.action(function () {
			media.help();
		});

	media
		.command("list")
		.description("List uploaded media")
		.option("--limit <n>", "Items per page", "20")
		.option("--cursor <cursor>", "Pagination cursor")
		.action(async (opts) => {
			await withErrorHandler(async () => {
				const client = createClient();
				const result = await client.media.list({
					limit: Number(opts.limit),
					cursor: opts.cursor,
				});

				if (isTableMode(program.opts())) {
					outputTable(
						result.data.map((m) => ({
							id: m.id,
							filename: truncate(m.filename, 30),
							mime_type: m.mime_type,
							size: formatBytes(m.size),
						})),
					);
					if (result.has_more && result.next_cursor) {
						console.log(`\nNext: --cursor ${result.next_cursor}`);
					}
				} else {
					outputJson(result);
				}
			});
		});

	media
		.command("get")
		.description("Get media details")
		.argument("<id>", "Media ID")
		.action(async (id: string) => {
			await withErrorHandler(async () => {
				const client = createClient();
				const result = await client.media.retrieve(id);
				outputJson(result);
			});
		});

	media
		.command("upload")
		.description("Upload a file")
		.argument("<filepath>", "Path to file")
		.action(async (filepath: string) => {
			await withErrorHandler(async () => {
				const file = Bun.file(filepath);
				if (!(await file.exists())) {
					console.error(`File not found: ${filepath}`);
					process.exit(1);
				}

				const buffer = await file.arrayBuffer();
				const filename = basename(filepath);
				const client = createClient();
				const result = await client.media.upload(buffer, { filename });
				outputJson(result);
				outputSuccess(`Uploaded ${filename} (${formatBytes(result.size)})`);
			});
		});

	media
		.command("delete")
		.description("Delete a media file")
		.argument("<id>", "Media ID")
		.option("-y, --yes", "Skip confirmation")
		.action(async (id: string, opts) => {
			if (!opts.yes) {
				const confirmed = await prompts.confirm({
					message: `Delete media ${id}?`,
				});
				if (prompts.isCancel(confirmed) || !confirmed) {
					process.exit(0);
				}
			}

			await withErrorHandler(async () => {
				const client = createClient();
				await client.media.delete(id);
				outputSuccess(`Deleted ${id}`);
			});
		});
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
