import { describe, expect, test } from "bun:test";
import {
	createGenerationOneStampRecord,
	verifyGenerationOneStampRecord,
} from "./generation-1-stamp-record";

const identity = {
	workflowRunId: "123456789",
	sourceCommitSha: "a".repeat(40),
	apiVersionId: "api-version-id",
	appVersionId: "app-version-id",
};

describe("generation-1 stamp record", () => {
	test("binds one protected workflow run to exact source and Worker versions", () => {
		const record = createGenerationOneStampRecord(identity);
		expect(record).toEqual({
			schemaVersion: 1,
			kind: "prelive-generation-1-worker-stamp",
			generation: 1,
			...identity,
			tag: `baseline-1-stamp-${identity.sourceCommitSha}`,
			message: `Generation 1 stamp ${identity.sourceCommitSha}`,
		});
		expect(verifyGenerationOneStampRecord(record, identity)).toEqual(record);
	});

	test("rejects malformed identities and any record drift", () => {
		expect(() =>
			createGenerationOneStampRecord({ ...identity, workflowRunId: "0" }),
		).toThrow("run ID");
		expect(() =>
			createGenerationOneStampRecord({
				...identity,
				sourceCommitSha: identity.sourceCommitSha.toUpperCase(),
			}),
		).toThrow("lowercase full Git SHA");
		expect(() =>
			createGenerationOneStampRecord({
				...identity,
				apiVersionId: "api version",
			}),
		).toThrow("API");
		expect(() =>
			verifyGenerationOneStampRecord(
				{
					...createGenerationOneStampRecord(identity),
					appVersionId: "different",
				},
				identity,
			),
		).toThrow("does not exactly match");
		expect(() =>
			verifyGenerationOneStampRecord(
				{
					...createGenerationOneStampRecord(identity),
					extra: true,
				},
				identity,
			),
		).toThrow("does not exactly match");
	});
});
