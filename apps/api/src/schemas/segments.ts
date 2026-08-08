import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

const SegmentFilterOperator = z.enum([
	"eq",
	"neq",
	"contains",
	"not_contains",
	"starts_with",
	"ends_with",
	"gt",
	"gte",
	"lt",
	"lte",
	"in",
	"not_in",
	"exists",
	"not_exists",
]);

const SegmentFilterScalar = z.union([z.string(), z.number(), z.boolean()]);

/**
 * Dynamic segments deliberately expose only contact state that PostgreSQL can
 * evaluate without decrypting personal data. `fields.<slug>` resolves through
 * the tenant/scope-bound custom-field tables.
 */
export const SegmentFilterPredicate = z
	.object({
		field: z
			.string()
			.min(1)
			.max(80)
			.regex(
				/^(?:tags|contact\.tags|opted_in|contact\.opted_in|created_at|contact\.created_at|updated_at|contact\.updated_at|fields\.[a-z0-9_]{1,64})$/,
				"Unsupported dynamic-segment field",
			),
		op: SegmentFilterOperator,
		value: z
			.union([SegmentFilterScalar, z.array(SegmentFilterScalar).min(1).max(50)])
			.optional(),
		case_sensitive: z.boolean().optional(),
	})
	.strict()
	.superRefine((predicate, ctx) => {
		const field = predicate.field.replace(/^contact\./, "");
		const fail = (message: string, path: Array<string | number> = ["op"]) =>
			ctx.addIssue({ code: "custom", path, message });

		if (field === "tags") {
			if (!["contains", "not_contains"].includes(predicate.op)) {
				fail("Tag filters support only contains and not_contains");
			}
			if (typeof predicate.value !== "string") {
				fail("Tag filters require a string value", ["value"]);
			}
			if (predicate.case_sensitive !== undefined) {
				fail("Tag matching is exact; case_sensitive is not supported", [
					"case_sensitive",
				]);
			}
			return;
		}

		if (field === "opted_in") {
			if (!["eq", "neq"].includes(predicate.op)) {
				fail("opted_in filters support only eq and neq");
			}
			if (typeof predicate.value !== "boolean") {
				fail("opted_in filters require a boolean value", ["value"]);
			}
			if (predicate.case_sensitive !== undefined) {
				fail("case_sensitive is not valid for opted_in", ["case_sensitive"]);
			}
			return;
		}

		if (field === "created_at" || field === "updated_at") {
			if (!["eq", "neq", "gt", "gte", "lt", "lte"].includes(predicate.op)) {
				fail("Timestamp filters support only eq, neq, gt, gte, lt, and lte");
			}
			if (
				typeof predicate.value !== "string" ||
				!z.string().datetime().safeParse(predicate.value).success
			) {
				fail("Timestamp filters require an ISO-8601 datetime value", ["value"]);
			}
			if (predicate.case_sensitive !== undefined) {
				fail("case_sensitive is not valid for timestamps", ["case_sensitive"]);
			}
			return;
		}

		if (!field.startsWith("fields.")) return;
		if (predicate.op === "exists" || predicate.op === "not_exists") {
			if (predicate.value !== undefined) {
				fail(`${predicate.op} does not accept a value`, ["value"]);
			}
			if (predicate.case_sensitive !== undefined) {
				fail(`${predicate.op} does not accept case_sensitive`, [
					"case_sensitive",
				]);
			}
			return;
		}
		if (["gt", "gte", "lt", "lte"].includes(predicate.op)) {
			if (
				typeof predicate.value !== "number" ||
				!Number.isFinite(predicate.value)
			) {
				fail("Numeric custom-field comparisons require a finite number", [
					"value",
				]);
			}
			if (predicate.case_sensitive !== undefined) {
				fail("Numeric comparisons do not accept case_sensitive", [
					"case_sensitive",
				]);
			}
			return;
		}
		if (predicate.op === "in" || predicate.op === "not_in") {
			if (!Array.isArray(predicate.value) || predicate.value.length === 0) {
				fail(`${predicate.op} requires a non-empty scalar array`, ["value"]);
			}
			return;
		}
		if (
			["contains", "not_contains", "starts_with", "ends_with"].includes(
				predicate.op,
			) &&
			typeof predicate.value !== "string"
		) {
			fail(`${predicate.op} requires a string value`, ["value"]);
			return;
		}
		if (
			(predicate.op === "eq" || predicate.op === "neq") &&
			(predicate.value === undefined || Array.isArray(predicate.value))
		) {
			fail(`${predicate.op} requires a scalar value`, ["value"]);
		}
	});

export const SegmentFilter = z
	.object({
		all: z.array(SegmentFilterPredicate).max(50).optional(),
		any: z.array(SegmentFilterPredicate).max(50).optional(),
		none: z.array(SegmentFilterPredicate).max(50).optional(),
	})
	.strict()
	.superRefine((filter, ctx) => {
		const count =
			(filter.all?.length ?? 0) +
			(filter.any?.length ?? 0) +
			(filter.none?.length ?? 0);
		if (count === 0) {
			ctx.addIssue({
				code: "custom",
				message: "A dynamic segment filter must contain at least one predicate",
			});
		}
		if (count > 50) {
			ctx.addIssue({
				code: "custom",
				message: "A dynamic segment filter may contain at most 50 predicates",
			});
		}
	})
	.describe(
		"Derived membership filter, e.g. { all: [{ field: 'tags', op: 'contains', value: 'vip' }] }",
	);

export type SegmentFilterDefinition = z.infer<typeof SegmentFilter>;

const SegmentWriteFields = {
	name: z.string().min(1).max(200),
	description: z.string().optional(),
	workspace_id: z.string().optional(),
	filter: SegmentFilter.nullable().optional(),
	is_dynamic: z.boolean(),
} as const;

export const SegmentCreateSpec = z
	.object({
		...SegmentWriteFields,
		is_dynamic: z.boolean().default(true),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.is_dynamic && value.filter == null) {
			ctx.addIssue({
				code: "custom",
				path: ["filter"],
				message: "filter is required for a dynamic segment",
			});
		}
		if (!value.is_dynamic && value.filter != null) {
			ctx.addIssue({
				code: "custom",
				path: ["filter"],
				message: "Static segments store memberships, not a filter",
			});
		}
	});

export const SegmentUpdateSpec = z
	.object({
		name: SegmentWriteFields.name.optional(),
		description: SegmentWriteFields.description,
		filter: SegmentWriteFields.filter,
		is_dynamic: SegmentWriteFields.is_dynamic.optional(),
	})
	.strict();

export const SegmentResponse = z.object({
	id: z.string(),
	organization_id: z.string(),
	workspace_id: z.string().nullable(),
	name: z.string(),
	description: z.string().nullable(),
	filter: SegmentFilter.nullable(),
	is_dynamic: z.boolean(),
	member_count: z.number().int(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const SegmentListResponse = paginatedResponse(SegmentResponse);
