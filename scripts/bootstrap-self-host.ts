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
import { eq, ne } from "drizzle-orm";

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing required environment variable ${name}`);
	return value;
}

function organizationConfig(): { id: string; name: string; slug: string } {
	const id =
		process.env.RELAYAPI_ORGANIZATION_ID?.trim() || "org_relayapi_selfhost";
	const name = process.env.RELAYAPI_ORGANIZATION_NAME?.trim() || "RelayAPI";
	const slug = process.env.RELAYAPI_ORGANIZATION_SLUG?.trim() || "relayapi";
	if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
		throw new Error("RELAYAPI_ORGANIZATION_ID contains unsupported characters");
	}
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
		throw new Error("RELAYAPI_ORGANIZATION_SLUG must be a URL-safe slug");
	}
	return { id, name, slug };
}

export async function bootstrapSelfHostedAdmin(): Promise<void> {
	if (process.env.DEPLOYMENT_MODE !== "self_hosted") {
		throw new Error("Self-host bootstrap requires DEPLOYMENT_MODE=self_hosted");
	}
	const databaseUrl = required("DATABASE_URL");
	const email = required("RELAYAPI_ADMIN_EMAIL").toLowerCase();
	const password = required("RELAYAPI_ADMIN_PASSWORD");
	if (password.length < 12) {
		throw new Error(
			"RELAYAPI_ADMIN_PASSWORD must contain at least 12 characters",
		);
	}
	const betterAuthSecret = required("BETTER_AUTH_SECRET");
	const org = organizationConfig();
	const db = createDb(databaseUrl);

	const [unexpectedUser] = await db
		.select({ id: userTable.id })
		.from(userTable)
		.where(ne(userTable.email, email))
		.limit(1);
	const [existingUser] = await db
		.select({ id: userTable.id })
		.from(userTable)
		.where(eq(userTable.email, email))
		.limit(1);
	if (unexpectedUser && !existingUser) {
		throw new Error(
			"Refusing first-admin bootstrap because another identity already exists",
		);
	}

	let userId = existingUser?.id;
	if (!userId) {
		const auth = createAuth(db, {
			BETTER_AUTH_SECRET: betterAuthSecret,
			BETTER_AUTH_URL: "https://self-host-bootstrap.invalid",
			requireInvitationForSignUp: false,
			requireEmailVerification: false,
		});
		const result = await auth.api.signUpEmail({
			body: { email, password, name: "RelayAPI Admin" },
		});
		if (!result?.user?.id) {
			throw new Error("Better Auth did not create the self-host administrator");
		}
		userId = result.user.id;
	}
	const adminUserId = userId;

	await db.transaction(async (tx) => {
		await tx
			.update(userTable)
			.set({ role: "admin", emailVerified: true, updatedAt: new Date() })
			.where(eq(userTable.id, adminUserId));

		const [existingOrganization] = await tx
			.select({ id: organization.id })
			.from(organization)
			.where(eq(organization.slug, org.slug))
			.limit(1);
		let organizationId = existingOrganization?.id;
		if (!organizationId) {
			const [created] = await tx
				.insert(organization)
				.values({ id: org.id, name: org.name, slug: org.slug })
				.onConflictDoNothing()
				.returning({ id: organization.id });
			organizationId = created?.id;
		}
		if (!organizationId) {
			throw new Error("Could not create the self-host organization");
		}
		await tx
			.insert(member)
			.values({
				id: generateId("mem_"),
				userId: adminUserId,
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
		await tx
			.insert(organizationSubscriptions)
			.values({
				id: generateId("sub_"),
				organizationId,
				status: "cancelled",
				aiEnabled: process.env.SELF_HOSTED_FEATURE_AI === "1",
			})
			.onConflictDoNothing({
				target: organizationSubscriptions.organizationId,
			});
	});

	console.log("Self-host administrator and organization are ready");
}

if (import.meta.main) {
	bootstrapSelfHostedAdmin().then(
		() => process.exit(0),
		(error) => {
			console.error(
				`Self-host bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		},
	);
}
