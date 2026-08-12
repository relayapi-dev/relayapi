/// <reference types="astro/client" />

declare namespace Cloudflare {
	// Wrangler generates configured bindings in worker-configuration.d.ts.
	// Secrets are intentionally absent from wrangler.jsonc and merge in here.
	interface Env {
		KV: KVNamespace;
		AVATARS_BUCKET: R2Bucket;
		PUBLIC_ASSETS: R2Bucket;
		QUEUE_RESCUE_BUCKET: R2Bucket;
		HYPERDRIVE: Hyperdrive;
		EMAIL_INTENTS: import("@relayapi/sdk/internal").EmailIntentService;
		IDENTITY_DELETION_CONTRACT_VERSION: "identity-deletion-v1";
		BASELINE_GENERATION: "1";
		MAINTENANCE_SMOKE_BYPASS_SHA256?: string;
		DEPLOYMENT_MODE?: "hosted" | "self_hosted";
		SELF_HOSTED_FEATURE_AI?: "0" | "1";
		SELF_HOSTED_FEATURE_EMAIL?: "0" | "1";
		DATABASE_URL?: string;
		REMOTE_DASHBOARD_ORIGIN?: string;
		BETTER_AUTH_SECRET: string;
		BETTER_AUTH_URL?: string;
		GOOGLE_CLIENT_ID?: string;
		GOOGLE_CLIENT_SECRET?: string;
	}
}

declare module "cloudflare:workers" {
	const env: Cloudflare.Env;

	export { env };
}

declare namespace App {
	interface Locals {
		db: import("@relayapi/db").Database;
		auth: ReturnType<typeof import("@relayapi/auth").createAuth>;
		user: Record<string, unknown> | null;
		session: Record<string, unknown> | null;
		organization: Record<string, unknown> | null;
		organizationMembershipRole: string | null;
		/** Domain-separated server secret for dashboard API-key envelopes. */
		dashboardCredentialSecret: string;
		kv: {
			get: (key: string) => Promise<string | null>;
			put: (
				key: string,
				value: string,
				options?: { expirationTtl?: number },
			) => Promise<void>;
			delete: (key: string) => Promise<void>;
		};
	}
}
