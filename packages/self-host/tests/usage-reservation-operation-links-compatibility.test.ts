import { describe, expect, it } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host durable operation usage provenance compatibility", () => {
	it("installs the shared same-organization reservation links without enabling billing", async () => {
		const [readme, schema, financialRetention] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
			Bun.file(`${repositoryRoot}packages/db/src/schema.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/financial-retention.ts`,
			).text(),
		]);

		expect(readme).toContain(
			"same-organization usage-reservation provenance link",
		);
		expect(readme).toContain("does not enable Stripe billing");
		expect(readme).toContain("only for committed or released reservations");
		expect(financialRetention).toContain(
			'inArray(usageReservations.state, ["committed", "released"])',
		);
		expect(financialRetention).toContain(".set({ usageReservationId: null })");
		expect(financialRetention).toContain(
			".set({ provisioningUsageReservationId: null })",
		);
		expect(financialRetention).toContain(
			".set({ releaseUsageReservationId: null })",
		);

		for (const constraint of [
			"ad_creation_operations_usage_reservation_org_fk",
			"ad_mutation_operations_usage_reservation_org_fk",
			"wa_phone_provisioning_usage_reservation_org_fk",
			"wa_phone_release_usage_reservation_org_fk",
		]) {
			expect(schema).toContain(constraint);
		}
		for (const index of [
			"ad_creation_operations_usage_reservation_uniq",
			"ad_mutation_operations_usage_reservation_uniq",
			"wa_phone_provisioning_usage_reservation_uniq",
			"wa_phone_release_usage_reservation_uniq",
		]) {
			expect(schema).toContain(index);
		}
		expect(
			schema.match(/usageReservationId: text\("usage_reservation_id"\),/g),
		).toHaveLength(2);
		expect(schema).toContain(
			'provisioningUsageReservationId: text("usage_reservation_id")',
		);
		expect(schema).toContain(
			'releaseUsageReservationId: text("usage_reservation_id")',
		);
	});
});
