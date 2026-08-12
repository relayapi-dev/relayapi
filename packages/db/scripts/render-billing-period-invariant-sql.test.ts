import { describe, expect, it } from "bun:test";
import { renderBillingPeriodInvariantSql } from "./render-billing-period-invariant-sql";

describe("billing period invariant SQL", () => {
	it("enforces non-overlap, split deferral, and immutable authority", () => {
		const sql = renderBillingPeriodInvariantSql();
		expect(sql).toContain("EXCLUDE USING gist");
		expect(sql).toContain("tstzrange(period_start, period_end, '[)')");
		expect(sql).toContain("WHERE (state <> 'void')");
		expect(sql).toContain("DEFERRABLE INITIALLY IMMEDIATE");
		expect(sql).toContain("an open billing period may only be shortened");
		expect(sql).toContain("billing period authority fields are immutable");
		expect(sql).toContain(
			"NEW.effective_included_units_snapshot IS DISTINCT FROM OLD.effective_included_units_snapshot",
		);
		expect(sql).toContain(
			"OLD.state = 'released' AND NEW.state IN ('closed', 'void')",
		);
	});

	it("makes each phone billing revision economically immutable and provider evidence append-only", () => {
		const sql = renderBillingPeriodInvariantSql();
		const baseAttempt = sql.slice(
			sql.indexOf("enforce_billing_operation_attempt_authority"),
			sql.indexOf("enforce_phone_billing_attempt_authority"),
		);
		const phoneAttempt = sql.slice(
			sql.indexOf("enforce_phone_billing_attempt_authority"),
		);
		expect(baseAttempt).toContain("IF NEW.id IS DISTINCT FROM OLD.id");
		expect(phoneAttempt).toContain("IF NEW.id IS DISTINCT FROM OLD.id");
		expect(sql).toContain("enforce_phone_billing_attempt_authority");
		expect(sql).toContain(
			"phone billing attempt target and economic payload are immutable",
		);
		expect(sql).toContain(
			"phone billing provider identity and evidence are append-only once observed",
		);
		expect(sql).toContain("NEW.provider_evidence @> OLD.provider_evidence");
		expect(sql).toContain("invalid phone billing attempt transition: %s -> %s");
		expect(sql).toContain(
			"BEFORE UPDATE ON public.whatsapp_phone_billing_attempts",
		);
	});
});
