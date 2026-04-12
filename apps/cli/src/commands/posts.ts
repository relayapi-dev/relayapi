import { Command } from "commander";
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

export function registerPostCommands(program: Command): void {
	const posts = program
		.command("posts")
		.description("Manage posts")
		.action(function () {
			posts.help();
		});

	posts
		.command("create")
		.description("Create a post")
		.option("--content <text>", "Post content")
		.option("--targets <ids>", "Account IDs or platform names (comma-separated)")
		.option("--schedule <when>", 'Publish timing: "now", "draft", or ISO timestamp')
		.option("--media <urls>", "Media URLs (comma-separated)")
		.option("--timezone <tz>", "IANA timezone for scheduling")
		.action(async (opts) => {
			let content = opts.content as string | undefined;
			let targets = opts.targets
				? (opts.targets as string).split(",").map((t: string) => t.trim())
				: undefined;
			let schedule = opts.schedule as string | undefined;

			if (!content || !targets || !schedule) {
				// Interactive mode
				if (!content) {
					const result = await prompts.text({
						message: "Post content",
						placeholder: "What would you like to post?",
					});
					if (prompts.isCancel(result)) process.exit(0);
					content = result;
				}

				if (!targets) {
					const client = createClient();
					const accounts = await client.accounts.list({ limit: 100 });
					const selected = await prompts.multiselect({
						message: "Select target accounts",
						options: accounts.data.map((a) => ({
							value: a.id,
							label: `${a.platform} — ${a.username ?? a.display_name ?? a.id}`,
						})),
					});
					if (prompts.isCancel(selected)) process.exit(0);
					targets = selected as string[];
				}

				if (!schedule) {
					const result = await prompts.select({
						message: "When to publish?",
						options: [
							{ value: "now", label: "Publish now" },
							{ value: "draft", label: "Save as draft" },
							{ value: "schedule", label: "Schedule for later" },
						],
					});
					if (prompts.isCancel(result)) process.exit(0);

					if (result === "schedule") {
						const time = await prompts.text({
							message: "ISO timestamp (e.g. 2026-04-01T12:00:00Z)",
						});
						if (prompts.isCancel(time)) process.exit(0);
						schedule = time;
					} else {
						schedule = result as string;
					}
				}
			}

			await withErrorHandler(async () => {
				const client = createClient();
				const result = await client.posts.create({
					content,
					targets: targets!,
					scheduled_at: schedule!,
					media: opts.media
						? (opts.media as string)
								.split(",")
								.map((url: string) => ({ url: url.trim() }))
						: undefined,
					timezone: opts.timezone,
				});
				outputJson(result);
				outputSuccess(`Post ${result.id} created (${result.status})`);
			});
		});

	posts
		.command("list")
		.description("List posts")
		.option("--limit <n>", "Items per page", "20")
		.option("--cursor <cursor>", "Pagination cursor")
		.action(async (opts) => {
			await withErrorHandler(async () => {
				const client = createClient();
				const result = await client.posts.list({
					limit: Number(opts.limit),
					cursor: opts.cursor,
				});

				if (isTableMode(program.opts())) {
					outputTable(
						result.data.map((p) => ({
							id: p.id,
							status: p.status,
							content: truncate(p.content ?? "", 40),
							scheduled_at: p.scheduled_at ?? "-",
							targets: Object.keys(p.targets).join(", "),
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

	posts
		.command("get")
		.description("Get post details")
		.argument("<id>", "Post ID")
		.action(async (id: string) => {
			await withErrorHandler(async () => {
				const client = createClient();
				const result = await client.posts.retrieve(id);
				outputJson(result);
			});
		});

	posts
		.command("update")
		.description("Update a draft or scheduled post")
		.argument("<id>", "Post ID")
		.option("--content <text>", "Updated content")
		.option("--targets <ids>", "Updated targets (comma-separated)")
		.option("--schedule <when>", 'Updated schedule: "now", "draft", or ISO timestamp')
		.option("--timezone <tz>", "IANA timezone")
		.action(async (id: string, opts) => {
			await withErrorHandler(async () => {
				const client = createClient();
				const result = await client.posts.update(id, {
					content: opts.content,
					targets: opts.targets
						? (opts.targets as string).split(",").map((t: string) => t.trim())
						: undefined,
					scheduled_at: opts.schedule,
					timezone: opts.timezone,
				});
				outputJson(result);
				outputSuccess(`Post ${result.id} updated`);
			});
		});

	posts
		.command("delete")
		.description("Delete a draft or scheduled post")
		.argument("<id>", "Post ID")
		.option("-y, --yes", "Skip confirmation")
		.action(async (id: string, opts) => {
			if (!opts.yes) {
				const confirmed = await prompts.confirm({
					message: `Delete post ${id}?`,
				});
				if (prompts.isCancel(confirmed) || !confirmed) {
					process.exit(0);
				}
			}

			await withErrorHandler(async () => {
				const client = createClient();
				await client.posts.delete(id);
				outputSuccess(`Deleted ${id}`);
			});
		});

	posts
		.command("retry")
		.description("Retry failed targets on a post")
		.argument("<id>", "Post ID")
		.action(async (id: string) => {
			await withErrorHandler(async () => {
				const client = createClient();
				const result = await client.posts.retry(id);
				outputJson(result);
				outputSuccess(`Retrying post ${result.id}`);
			});
		});

	posts
		.command("unpublish")
		.description("Unpublish a post from all platforms")
		.argument("<id>", "Post ID")
		.option("-y, --yes", "Skip confirmation")
		.action(async (id: string, opts) => {
			if (!opts.yes) {
				const confirmed = await prompts.confirm({
					message: `Unpublish post ${id}?`,
				});
				if (prompts.isCancel(confirmed) || !confirmed) {
					process.exit(0);
				}
			}

			await withErrorHandler(async () => {
				const client = createClient();
				const result = await client.posts.unpublish(id);
				outputJson(result);
				outputSuccess(`Unpublished ${result.id}`);
			});
		});
}
