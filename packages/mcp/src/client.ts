import Relay from "@relayapi/sdk";
import type { Config } from "./config.js";
import type { RelayLike } from "./server.js";

export function createRelayClient(config: Config): RelayLike {
	const client = new Relay({
		apiKey: config.apiKey,
		baseURL: config.baseURL,
	});

	return {
		automations: {
			catalog: () => client.automations.catalog(),
			list: (query) =>
				client.automations.list(
					query as Parameters<typeof client.automations.list>[0],
				),
			retrieve: (id) => client.automations.retrieve(id),
			create: (body) =>
				client.automations.create(
					body as unknown as Parameters<typeof client.automations.create>[0],
				),
			update: (id, body) =>
				client.automations.update(
					id,
					body as Parameters<typeof client.automations.update>[1],
				),
			delete: (id) => client.automations.delete(id),
			activate: (id) => client.automations.activate(id),
			pause: (id) => client.automations.pause(id),
			resume: (id) => client.automations.resume(id),
			archive: (id) => client.automations.archive(id),
			simulate: (id, body) =>
				client.automations.simulate(
					id,
					body as Parameters<typeof client.automations.simulate>[1],
				),
		},
		automationRuns: {
			list: (automationId, query) =>
				client.automationRuns.list(
					automationId,
					query as Parameters<typeof client.automationRuns.list>[1],
				),
			listSteps: (runId, query) =>
				client.automationRuns.listSteps(
					runId,
					query as Parameters<typeof client.automationRuns.listSteps>[1],
				),
		},
	};
}

export type RelayClient = RelayLike;
