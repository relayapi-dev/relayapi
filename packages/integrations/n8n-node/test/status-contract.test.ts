import { describe, expect, it } from 'bun:test';
import { RelayApi } from '../nodes/RelayApi/RelayApi.node';

describe('n8n post status contract', () => {
	it('only advertises list filters accepted by the pinned RelayAPI OpenAPI contract', async () => {
		const node = new RelayApi();
		const statusProperty = node.description.properties.find(
			(property) => property.name === 'status',
		);
		expect(statusProperty).toBeDefined();

		const advertisedStatuses = (statusProperty?.options ?? [])
			.map((option) => String(option.value))
			.filter(Boolean);

		expect(advertisedStatuses).toContain('partial');

		const specUrl = new URL('../../../../apps/docs/openapi.json', import.meta.url);
		const spec = (await Bun.file(specUrl).json()) as {
			paths: Record<
				string,
				{ get?: { parameters?: Array<{ name?: string; schema?: { enum?: string[] } }> } }
			>;
		};
		const apiStatuses =
			spec.paths['/v1/posts']?.get?.parameters?.find(
				(parameter) => parameter.name === 'status',
			)?.schema?.enum ?? [];

		for (const status of advertisedStatuses) {
			expect(apiStatuses).toContain(status);
		}
	});
});
