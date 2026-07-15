import { createAuth } from "@relayapi/auth";
import {
	createDb,
	generateId,
	member,
	organization,
	organizationSettings,
	organizationSubscriptions,
	user as userTable,
} from "@relayapi/db";
import { eq } from "drizzle-orm";
import { assertSafeSeedEnvironment } from "./seed-safety";

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

function seedOrganizationConfig(): { id: string; name: string; slug: string } {
	const id =
		process.env.SEED_ORGANIZATION_ID?.trim() || "org_relayapi_local_seed";
	const name =
		process.env.SEED_ORGANIZATION_NAME?.trim() || "RelayAPI Local Development";
	const slug =
		process.env.SEED_ORGANIZATION_SLUG?.trim() || "relayapi-local-dev";

	if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
		throw new Error("SEED_ORGANIZATION_ID contains unsupported characters");
	}
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
		throw new Error(
			"SEED_ORGANIZATION_SLUG must contain lowercase letters, numbers, and single hyphens",
		);
	}
	return { id, name, slug };
}

export async function seedLocalDevelopment(): Promise<void> {
	// This guard intentionally runs before any database client/auth object exists.
	const connectionString = assertSafeSeedEnvironment(process.env);
	const seedUserEmail = requireEnv("SEED_USER_EMAIL").toLowerCase();
	const seedUserPassword = requireEnv("SEED_USER_PASSWORD");
	const seedUserName = process.env.SEED_USER_NAME?.trim() || "Dev User";
	const orgConfig = seedOrganizationConfig();

	const db = createDb(connectionString);
	const auth = createAuth(db, {
		BETTER_AUTH_SECRET: "seed-secret-not-used-for-real-auth",
		BETTER_AUTH_URL: "http://localhost:8789",
	});

	console.log("Resolving local development user...");
	const [existingUser] = await db
		.select({ id: userTable.id })
		.from(userTable)
		.where(eq(userTable.email, seedUserEmail))
		.limit(1);

	let userId = existingUser?.id;
	if (!userId) {
		const signUpResult = await auth.api.signUpEmail({
			body: {
				email: seedUserEmail,
				password: seedUserPassword,
				name: seedUserName,
			},
		});
		if (!signUpResult?.user) {
			throw new Error("Better Auth did not return the created seed user");
		}
		userId = signUpResult.user.id;
		console.log(`Created user: ${userId}`);
	} else {
		console.log(`Reusing existing user: ${userId}`);
	}

	const organizationId = await db.transaction(async (tx) => {
		const [existingOrganization] = await tx
			.select({ id: organization.id })
			.from(organization)
			.where(eq(organization.slug, orgConfig.slug))
			.limit(1);

		let organizationId = existingOrganization?.id;
		if (!organizationId) {
			const [createdOrganization] = await tx
				.insert(organization)
				.values({
					id: orgConfig.id,
					name: orgConfig.name,
					slug: orgConfig.slug,
				})
				.onConflictDoNothing()
				.returning({ id: organization.id });
			organizationId = createdOrganization?.id;

			// A concurrent seed may have won the slug insert while we waited.
			if (!organizationId) {
				const [concurrentOrganization] = await tx
					.select({ id: organization.id })
					.from(organization)
					.where(eq(organization.slug, orgConfig.slug))
					.limit(1);
				organizationId = concurrentOrganization?.id;
			}
		}

		if (!organizationId) {
			throw new Error(
				"Could not create the seed organization; its deterministic id may already belong to another slug",
			);
		}

		await tx
			.insert(member)
			.values({
				id: generateId("mem_"),
				userId,
				organizationId,
				role: "owner",
			})
			.onConflictDoUpdate({
				target: [member.userId, member.organizationId],
				set: { role: "owner" },
			});

		await tx
			.insert(organizationSettings)
			.values({ organizationId, requireWorkspaceId: false })
			.onConflictDoNothing({ target: organizationSettings.organizationId });

		// A settings row is useful locally, but it is not proof of a paid plan.
		// The cancelled/free-safe defaults deliberately grant no Stripe entitlement.
		await tx
			.insert(organizationSubscriptions)
			.values({
				id: generateId("sub_"),
				organizationId,
				status: "cancelled",
				aiEnabled: false,
				dailyToolLimit: 2,
			})
			.onConflictDoNothing({
				target: organizationSubscriptions.organizationId,
			});

		return organizationId;
	});

	console.log("\nLocal seed complete");
	console.log(`  Organization: ${orgConfig.name} (${organizationId})`);
	console.log(
		"  Billing entitlement: free (no fabricated active subscription)",
	);
}

if (import.meta.main) {
	seedLocalDevelopment().then(
		() => process.exit(0),
		(error) => {
			console.error("Seed failed:", error);
			process.exit(1);
		},
	);
}
