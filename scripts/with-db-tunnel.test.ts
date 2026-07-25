import { describe, expect, it } from "bun:test";
import {
	assertTunnelConnectionString,
	commandFromArguments,
	normalizedTunnelConnectionString,
	resolveDatabaseTunnelConfig,
} from "./with-db-tunnel";

const CONNECTION_ENV =
	"CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE";
const TUNNEL_ENV = { RELAYAPI_DB_SSH_TARGET: "relayapi-db" };
const LOOPBACK_DATABASE_URL = [
	"postgresql://developer:",
	"synthetic-password",
	"@localhost:5433/relayapi?sslmode=disable",
].join("");
const REMOTE_DATABASE_URL = [
	"postgresql://developer:",
	"synthetic-password",
	"@db.example.com:5432/relayapi?sslmode=verify-full",
].join("");

describe("command-scoped database tunnel", () => {
	it("uses a loopback-only listener and the configured SSH target", () => {
		const config = resolveDatabaseTunnelConfig(TUNNEL_ENV);
		expect(config).toEqual({
			localHost: "127.0.0.1",
			localPort: 5433,
			remoteHost: "localhost",
			remotePort: 5432,
			sshTarget: "relayapi-db",
		});
	});

	it("requires the SSH target to come from the local environment", () => {
		expect(() => resolveDatabaseTunnelConfig({})).toThrow(
			"RELAYAPI_DB_SSH_TARGET is required",
		);
	});

	it("accepts only a connection string aimed at the owned tunnel port", () => {
		const config = resolveDatabaseTunnelConfig(TUNNEL_ENV);
		expect(() =>
			assertTunnelConnectionString(
				{
					[CONNECTION_ENV]: LOOPBACK_DATABASE_URL,
				},
				config,
			),
		).not.toThrow();
	});

	it("rejects direct remote database targets", () => {
		const config = resolveDatabaseTunnelConfig(TUNNEL_ENV);
		expect(() =>
			assertTunnelConnectionString(
				{
					[CONNECTION_ENV]: REMOTE_DATABASE_URL,
				},
				config,
			),
		).toThrow("must point at the local SSH tunnel");
	});

	it("normalizes localhost to the exact IPv4 listener owned by the wrapper", () => {
		const config = resolveDatabaseTunnelConfig(TUNNEL_ENV);
		const normalized = normalizedTunnelConnectionString(
			{
				[CONNECTION_ENV]: LOOPBACK_DATABASE_URL,
			},
			config,
		);
		expect(new URL(normalized).hostname).toBe("127.0.0.1");
	});

	it("preserves child command arguments without shell interpolation", () => {
		expect(commandFromArguments(["--", "bun", "run", "db:migrate"])).toEqual([
			"bun",
			"run",
			"db:migrate",
		]);
	});
});
