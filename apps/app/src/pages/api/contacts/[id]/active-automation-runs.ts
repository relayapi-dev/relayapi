// Active automation runs for a single contact (Plan 3 — Unit C4, Task V1).
//
// There's no dedicated "runs by contact across automations" endpoint on
// the API side; runs are always scoped under an automation. The inbox
// needs a single cross-cutting query to decide whether to show the
// automation badge, so we do the N+1 here on the dashboard: list active
// automations for the org, then fetch this contact's active runs from
// each one. Returns a flat `{ runs: [...], automations: [...] }` payload
// so the badge can render without another round trip for the automation
// name.
//
// Volume is small in practice — orgs have a handful of live automations
// at most, and each sub-query returns at most a few runs for this one
// contact. If/when the API grows a first-class cross-automation runs
// endpoint, swap this out.

import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

interface MinimalAutomation {
	id: string;
	name: string;
	channel: string;
	status: string;
}

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;

	try {
		const contactId = ctx.params.id;
		if (!contactId) {
			return Response.json(
				{ error: { code: "INVALID_REQUEST", message: "Missing contact id" } },
				{ status: 400 },
			);
		}

		// 1. List active automations for this org. `list` is cursor-paginated;
		// in practice orgs won't have thousands of active automations, so we
		// cap at 100 and iterate a couple of cursors max.
		const automations: MinimalAutomation[] = [];
		let cursor: string | null | undefined = undefined;
		let pages = 0;
		do {
			const page: Awaited<ReturnType<typeof client.automations.list>> =
				await client.automations.list({
					status: "active",
					limit: 100,
					cursor: cursor ?? undefined,
				});
			for (const row of page.data) {
				automations.push({
					id: row.id,
					name: row.name,
					channel: row.channel,
					status: row.status,
				});
			}
			cursor = page.has_more ? page.next_cursor : null;
			pages += 1;
		} while (cursor && pages < 5);

		// 2. Fan out active + waiting runs per automation, filtered by contact.
		// "active" and "waiting" are both considered live for badge purposes.
		type RunRow = {
			id: string;
			automation_id: string;
			contact_id: string;
			status: string;
			current_node_key: string | null;
			current_port_key: string | null;
			started_at: string;
		};
		const allRuns: RunRow[] = [];
		await Promise.all(
			automations.map(async (a) => {
				try {
					const [active, waiting] = await Promise.all([
						client.automationRuns.list(a.id, {
							contact_id: contactId,
							status: "active",
							limit: 10,
						}),
						client.automationRuns.list(a.id, {
							contact_id: contactId,
							status: "waiting",
							limit: 10,
						}),
					]);
					for (const run of [...active.data, ...waiting.data]) {
						allRuns.push({
							id: run.id,
							automation_id: run.automation_id,
							contact_id: run.contact_id,
							status: run.status,
							current_node_key: run.current_node_key,
							current_port_key: run.current_port_key,
							started_at: run.started_at,
						});
					}
				} catch {
					// A single automation's run lookup failing shouldn't tank the
					// whole badge — skip and move on.
				}
			}),
		);

		// Order newest-first so the inbox shows the most recently started run
		// when a contact is enrolled in multiple automations.
		allRuns.sort(
			(a, b) =>
				new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
		);

		return Response.json(
			{
				runs: allRuns,
				automations,
			},
			{
				headers: {
					// Short TTL — freshness matters but we don't want the inbox to
					// hammer the API as users click between conversations.
					"Cache-Control": "private, max-age=15",
				},
			},
		);
	} catch (e) {
		return handleSdkError(e);
	}
};
