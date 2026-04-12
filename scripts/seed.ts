import { createDb, organization, member, organizationSubscriptions, generateId } from "@relayapi/db";
import { createAuth } from "@relayapi/auth";

const CONNECTION_STRING = requireEnv("DATABASE_URL");

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

const db = createDb(CONNECTION_STRING);
const auth = createAuth(db, {
	BETTER_AUTH_SECRET: "seed-secret-not-used-for-real-auth",
	BETTER_AUTH_URL: "http://localhost:8789",
});

async function seed() {
	console.log("Seeding test user...");
	const seedUserEmail = requireEnv("SEED_USER_EMAIL");
	const seedUserPassword = requireEnv("SEED_USER_PASSWORD");
	const seedUserName = process.env.SEED_USER_NAME?.trim() || "Dev User";

	// 1. Sign up the user (Better Auth handles password hashing)
	const signUpResult = await auth.api.signUpEmail({
		body: {
			email: seedUserEmail,
			password: seedUserPassword,
			name: seedUserName,
		},
	});

	if (!signUpResult?.user) {
		console.error("Failed to create user:", signUpResult);
		process.exit(1);
	}

	const userId = signUpResult.user.id;
	console.log(`Created user: ${userId}`);

	// 2. Create an organization
	const orgId = generateId("ws_");
	await db.insert(organization).values({
		id: orgId,
		name: "Zank's Workspace",
		slug: "zank-workspace",
	});
	console.log(`Created organization: ${orgId}`);

	// 3. Add user as owner of the organization
	await db.insert(member).values({
		id: generateId("mem_"),
		userId,
		organizationId: orgId,
		role: "owner",
	});
	console.log("Added user as org owner");

	// 4. Create pro subscription for the organization
	const now = new Date();
	const periodEnd = new Date(now);
	periodEnd.setMonth(periodEnd.getMonth() + 1);

	await db.insert(organizationSubscriptions).values({
		id: generateId("sub_"),
		organizationId: orgId,
		status: "active",
		postsIncluded: 10000,
		pricePerPostCents: 1,
		monthlyPriceCents: 500,
		currentPeriodStart: now,
		currentPeriodEnd: periodEnd,
		cancelAtPeriodEnd: false,
		aiEnabled: true,
		dailyToolLimit: 10,
	});
	console.log("Created pro subscription");

	console.log("\nSeed complete!");
	console.log(`  Organization: Zank's Workspace (${orgId})`);
	console.log(`  Plan: Pro (active)`);

	process.exit(0);
}

seed().catch((err) => {
	console.error("Seed failed:", err);
	process.exit(1);
});
