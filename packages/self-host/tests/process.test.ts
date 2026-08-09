import { describe, expect, it } from "bun:test";
import { runCaptured } from "../src/process.js";

describe("runCaptured", () => {
	it("returns the complete stdout of a command that exits immediately after writing", async () => {
		// Guards output completeness past the pipe buffer, which is the size range
		// of `wrangler versions list --json` on a Worker with many versions.
		//
		// Note this does NOT deterministically reproduce the exit-vs-close race
		// the implementation was fixed for: whether stdout is fully drained by the
		// time "exit" fires is platform- and timing-dependent, and it happens to
		// be drained here. The fix rests on Node's documented contract — "exit"
		// may fire while stdio is still open, "close" fires only after every
		// stream is closed — not on this assertion failing beforehand.
		const line = `${"x".repeat(255)}\n`;
		const lines = 8192; // ~2MB, comfortably past any pipe buffer
		const output = await runCaptured(process.execPath, [
			"-e",
			`process.stdout.write(${JSON.stringify(line)}.repeat(${lines}))`,
		]);

		expect(output.length).toBe(line.length * lines);
		expect(output.endsWith(line)).toBe(true);
	});

	it("round-trips JSON large enough to span many writes", async () => {
		const payload = {
			items: Array.from({ length: 5000 }, (_, index) => ({
				id: `version_${index}`,
				annotations: { "workers/tag": `tag-${index}` },
			})),
		};
		const output = await runCaptured(process.execPath, [
			"-e",
			`process.stdout.write(JSON.stringify(${JSON.stringify(payload)}))`,
		]);

		expect(() => JSON.parse(output)).not.toThrow();
		expect(JSON.parse(output)).toEqual(payload);
	});

	it("rejects with the command's exit status rather than partial output", async () => {
		expect(
			runCaptured(process.execPath, [
				"-e",
				"process.stdout.write('partial'); process.exit(3)",
			]),
		).rejects.toThrow("exit code 3");
	});
});
