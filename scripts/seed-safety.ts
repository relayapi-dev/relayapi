export const LOCAL_SEED_CONFIRMATION =
	"I_UNDERSTAND_THIS_MODIFIES_MY_LOCAL_DATABASE";

export function assertSafeSeedEnvironment(
	env: Record<string, string | undefined>,
): string {
	const nodeEnvironment = env.NODE_ENV?.trim().toLowerCase();
	if (nodeEnvironment === "production") {
		throw new Error(
			"Refusing to run the development seed in NODE_ENV=production",
		);
	}
	if (nodeEnvironment !== "development") {
		throw new Error("The development seed requires NODE_ENV=development");
	}

	if (env.RELAYAPI_ALLOW_LOCAL_SEED?.trim() !== LOCAL_SEED_CONFIRMATION) {
		throw new Error(
			`Refusing to seed without RELAYAPI_ALLOW_LOCAL_SEED=${LOCAL_SEED_CONFIRMATION}`,
		);
	}

	const connectionString = env.DATABASE_URL?.trim();
	if (!connectionString) {
		throw new Error("Missing required environment variable: DATABASE_URL");
	}

	let parsed: URL;
	try {
		parsed = new URL(connectionString);
	} catch {
		throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
	}

	if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
		throw new Error(
			"DATABASE_URL must use the postgres or postgresql protocol",
		);
	}

	const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
	if (!localHosts.has(parsed.hostname.toLowerCase())) {
		throw new Error(
			"Refusing to seed a non-loopback database; use the documented localhost SSH tunnel",
		);
	}

	return connectionString;
}
