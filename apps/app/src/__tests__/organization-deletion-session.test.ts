import { describe, expect, it } from "bun:test";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

describe("organization deletion session recovery", () => {
	it("refreshes the active organization and ignores stale cookie tenant IDs", async () => {
		const [settingsSource, middlewareSource] = await Promise.all([
			Bun.file(
				`${repoRoot}apps/app/src/components/dashboard/pages/settings-page.tsx`,
			).text(),
			Bun.file(`${repoRoot}apps/app/src/middleware/index.ts`).text(),
		]);

		expect(settingsSource).toContain("await orgClient.list()");
		expect(settingsSource).toContain("await orgClient.setActive({");
		expect(settingsSource).toContain(
			"organizationId: remainingOrganizations?.[0]?.id ?? null",
		);
		expect(middlewareSource).toContain(
			"if (user && shouldCheckOnboarding(path) && !organization)",
		);
		expect(middlewareSource).not.toContain(
			"shouldCheckOnboarding(path) && !session?.activeOrganizationId",
		);
	});
});
