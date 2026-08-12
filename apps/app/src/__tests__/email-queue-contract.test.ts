import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appRoot = resolve(import.meta.dir, "../..");
const repoRoot = resolve(appRoot, "../..");

function source(path: string): string {
	return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("dashboard email intent boundary", () => {
	it("binds the app to the API entrypoint without a Queue or provider secret", () => {
		const config = JSON.parse(source("apps/app/wrangler.jsonc")) as {
			services?: unknown;
			queues?: unknown;
		};
		expect(config.services).toEqual([
			{
				binding: "EMAIL_INTENTS",
				service: "relayapi",
				entrypoint: "EmailIntentEntrypoint",
			},
		]);
		expect(config.queues).toBeUndefined();
		expect(source("apps/app/package.json")).not.toContain('"resend"');
		expect(source("apps/app/src/env.d.ts")).not.toContain("RESEND_API_KEY");
	});

	it("sends typed domain intents without exposing an envelope to the app", () => {
		const middleware = source("apps/app/src/middleware/index.ts");
		expect(middleware).toContain('from "@relayapi/sdk/internal"');
		expect(middleware).toContain('type: "organization_invitation"');
		expect(middleware).toContain("occurrenceId: data.occurrenceId");
		expect(middleware).toContain('type: "account_action"');
		expect(middleware).toContain("authUserId: data.userId");
		expect(middleware).not.toContain("EMAIL_QUEUE");
		expect(middleware).not.toContain("new Resend");
		expect(middleware).not.toContain(".emails.send");

		const contract = source("packages/sdk/src/internal.ts");
		expect(contract).toContain("interface EmailIntentService");
		expect(contract).not.toContain("to:");
		expect(contract).not.toContain("subject:");
		expect(contract).not.toContain("html:");
	});

	it("delegates resend and support requests to public SDK methods", () => {
		const resend = source("apps/app/src/pages/api/invitations/[id]/resend.ts");
		const support = source("apps/app/src/pages/api/on-demand-request.ts");
		expect(resend).toContain("client.emailIntents.resendInvitation");
		expect(support).toContain("client.emailIntents.requestOnDemandPlatform");
		for (const route of [resend, support]) {
			expect(route).not.toContain("@relayapi/db");
			expect(route).not.toContain("EMAIL_QUEUE");
			expect(route).not.toContain("Resend");
			expect(route).not.toContain(".emails.send");
		}
	});

	it("passes the auth user ID and deploys the API before the bound app", () => {
		const auth = source("packages/auth/src/index.ts");
		expect(auth).toContain("userId: resetUser.id");
		expect(auth).toContain("userId: unverifiedUser.id");
		expect(auth).toContain("userId: deletingUser.id");

		const cutover = source(".github/workflows/prelive-baseline-cutover.yml");
		expect(cutover.indexOf("secrets:cf:deploy -- api")).toBeGreaterThan(-1);
		expect(cutover.indexOf("secrets:cf:deploy -- api")).toBeLessThan(
			cutover.indexOf("secrets:cf:deploy -- app"),
		);

		const hostedAppDeploy = source(".github/workflows/deploy-app.yml");
		const targetGuard = hostedAppDeploy.indexOf(
			"Wait for the live API EmailIntentEntrypoint target",
		);
		const appDeploy = hostedAppDeploy.indexOf("Attempt App deploy");
		expect(targetGuard).toBeGreaterThan(-1);
		expect(targetGuard).toBeLessThan(appDeploy);
		expect(hostedAppDeploy).toContain("/workers/scripts/relayapi/content/v2");
		expect(hostedAppDeploy).toContain('"EmailIntentEntrypoint"');
		expect(hostedAppDeploy).toContain("for attempt in $(seq 1 60)");
		expect(hostedAppDeploy).toContain("sleep 20");
	});
});
