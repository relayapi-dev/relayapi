import { contacts, type Database, segments } from "@relayapi/db";
import { and, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import {
	SegmentFilter,
	type SegmentFilterDefinition,
} from "../schemas/segments";

export type SegmentDefinitionRow = Pick<
	typeof segments.$inferSelect,
	| "id"
	| "organizationId"
	| "workspaceId"
	| "scopeKey"
	| "filter"
	| "isDynamic"
	| "memberCount"
>;

type SegmentPredicate = NonNullable<SegmentFilterDefinition["all"]>[number];

function storedFilter(
	value: unknown,
	segmentId?: string,
): SegmentFilterDefinition {
	const parsed = SegmentFilter.safeParse(value);
	if (!parsed.success) {
		throw new Error(
			`Invalid dynamic segment filter${segmentId ? ` for ${segmentId}` : ""}: ${parsed.error.message}`,
		);
	}
	return parsed.data;
}

function customFieldExists(slug: string, valuePredicate?: SQL): SQL {
	return sql`EXISTS (
		SELECT 1
		FROM custom_field_values AS segment_cfv
		INNER JOIN custom_field_definitions AS segment_cfd
			ON segment_cfd.id = segment_cfv.definition_id
			AND segment_cfd.organization_id = segment_cfv.organization_id
			AND segment_cfd.scope_key = segment_cfv.definition_scope_key
		WHERE segment_cfv.contact_id = ${contacts.id}
			AND segment_cfv.organization_id = ${contacts.organizationId}
			AND segment_cfv.scope_key = ${contacts.scopeKey}
			AND segment_cfd.organization_id = ${contacts.organizationId}
			AND segment_cfd.slug = ${slug}
			${valuePredicate ? sql`AND ${valuePredicate}` : sql``}
	)`;
}

function textOperand(caseSensitive: boolean): SQL {
	return caseSensitive ? sql`segment_cfv.value` : sql`lower(segment_cfv.value)`;
}

function textValue(value: string, caseSensitive: boolean): string {
	return caseSensitive ? value : value.toLocaleLowerCase("en-US");
}

function customFieldValueMatches(predicate: SegmentPredicate): SQL {
	const caseSensitive = predicate.case_sensitive !== false;
	const actual = textOperand(caseSensitive);

	switch (predicate.op) {
		case "eq": {
			const expected = String(predicate.value);
			return sql`${actual} = ${textValue(expected, caseSensitive)}`;
		}
		case "contains": {
			const expected = textValue(String(predicate.value), caseSensitive);
			return sql`position(${expected} in ${actual}) > 0`;
		}
		case "not_contains": {
			const expected = textValue(String(predicate.value), caseSensitive);
			return sql`position(${expected} in ${actual}) = 0`;
		}
		case "starts_with": {
			const expected = textValue(String(predicate.value), caseSensitive);
			return sql`left(${actual}, length(${expected})) = ${expected}`;
		}
		case "ends_with": {
			const expected = textValue(String(predicate.value), caseSensitive);
			return sql`right(${actual}, length(${expected})) = ${expected}`;
		}
		case "gt":
			return sql`segment_cfv.value ~ '^[+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)$'
				AND segment_cfv.value::numeric > ${predicate.value as number}`;
		case "gte":
			return sql`segment_cfv.value ~ '^[+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)$'
				AND segment_cfv.value::numeric >= ${predicate.value as number}`;
		case "lt":
			return sql`segment_cfv.value ~ '^[+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)$'
				AND segment_cfv.value::numeric < ${predicate.value as number}`;
		case "lte":
			return sql`segment_cfv.value ~ '^[+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)$'
				AND segment_cfv.value::numeric <= ${predicate.value as number}`;
		case "in":
		case "not_in": {
			const values = (predicate.value as Array<string | number | boolean>).map(
				(value) => textValue(String(value), caseSensitive),
			);
			return inArray(actual, values);
		}
		default:
			throw new Error(`Unsupported custom-field operator ${predicate.op}`);
	}
}

function compileCustomFieldPredicate(predicate: SegmentPredicate): SQL {
	const slug = predicate.field.slice("fields.".length);
	if (predicate.op === "exists") return customFieldExists(slug);
	if (predicate.op === "not_exists")
		return sql`NOT (${customFieldExists(slug)})`;

	const matches = customFieldValueMatches(predicate);
	// neq/not_in treat a missing field as unequal/not-in. not_contains follows
	// the evaluator's string semantics and therefore requires an existing value.
	if (predicate.op === "neq") {
		const equalPredicate = { ...predicate, op: "eq" as const };
		return sql`NOT (${customFieldExists(
			slug,
			customFieldValueMatches(equalPredicate),
		)})`;
	}
	if (predicate.op === "not_in") {
		return sql`NOT (${customFieldExists(slug, matches)})`;
	}
	return customFieldExists(slug, matches);
}

function compileSegmentPredicate(predicate: SegmentPredicate): SQL {
	const field = predicate.field.replace(/^contact\./, "");
	if (field === "tags") {
		const contains = sql`${predicate.value as string} = ANY(${contacts.tags})`;
		return predicate.op === "not_contains" ? sql`NOT (${contains})` : contains;
	}
	if (field === "opted_in") {
		const equal = eq(contacts.optedIn, predicate.value as boolean);
		return predicate.op === "neq" ? sql`NOT (${equal})` : equal;
	}
	if (field === "created_at" || field === "updated_at") {
		const column =
			field === "created_at" ? contacts.createdAt : contacts.updatedAt;
		const value = predicate.value as string;
		switch (predicate.op) {
			case "eq":
				return sql`${column} = ${value}::timestamptz`;
			case "neq":
				return sql`${column} <> ${value}::timestamptz`;
			case "gt":
				return sql`${column} > ${value}::timestamptz`;
			case "gte":
				return sql`${column} >= ${value}::timestamptz`;
			case "lt":
				return sql`${column} < ${value}::timestamptz`;
			case "lte":
				return sql`${column} <= ${value}::timestamptz`;
			default:
				throw new Error(`Unsupported timestamp operator ${predicate.op}`);
		}
	}
	return compileCustomFieldPredicate(predicate);
}

/** Compile a validated filter into a parameterized predicate on `contacts`. */
export function compileSegmentFilter(filter: unknown, segmentId?: string): SQL {
	const parsed = storedFilter(filter, segmentId);
	const all = (parsed.all ?? []).map(compileSegmentPredicate);
	const any = (parsed.any ?? []).map(compileSegmentPredicate);
	const none = (parsed.none ?? []).map(
		(predicate) => sql`NOT (${compileSegmentPredicate(predicate)})`,
	);
	const clauses: SQL[] = [...all, ...none];
	if (any.length > 0) {
		const anyClause = or(...any);
		if (anyClause) clauses.push(anyClause);
	}
	const compiled = and(...clauses);
	if (!compiled) {
		throw new Error("A dynamic segment filter must contain a predicate");
	}
	return compiled;
}

/**
 * Match one contact row against one segment. Scope equality is part of the
 * predicate, so callers cannot accidentally apply a valid filter to a contact
 * from another workspace or tenant.
 */
export function contactMatchesSegment(segment: SegmentDefinitionRow): SQL {
	const identity = and(
		eq(contacts.organizationId, segment.organizationId),
		eq(contacts.scopeKey, segment.scopeKey),
	);
	if (segment.isDynamic) {
		return sql`${identity} AND (${compileSegmentFilter(
			segment.filter,
			segment.id,
		)})`;
	}
	return sql`${identity} AND EXISTS (
		SELECT 1
		FROM contact_segment_memberships AS segment_membership
		WHERE segment_membership.contact_id = ${contacts.id}
			AND segment_membership.segment_id = ${segment.id}
			AND segment_membership.organization_id = ${segment.organizationId}
			AND segment_membership.scope_key = ${segment.scopeKey}
	)`;
}

function groupByOrganization(
	rows: SegmentDefinitionRow[],
): Map<string, SegmentDefinitionRow[]> {
	const groups = new Map<string, SegmentDefinitionRow[]>();
	for (const row of rows) {
		const group = groups.get(row.organizationId) ?? [];
		group.push(row);
		groups.set(row.organizationId, group);
	}
	return groups;
}

function dynamicMatchValues(rows: SegmentDefinitionRow[]): SQL {
	return sql.join(
		rows.map(
			(segment) =>
				sql`(${segment.id}::text, (${contacts.scopeKey} = ${segment.scopeKey}
					AND (${compileSegmentFilter(segment.filter, segment.id)})))`,
		),
		sql`, `,
	);
}

/**
 * Return truthful counts without persisting a second authority. Static counts
 * come from the trigger-maintained relation counter; dynamic counts are one
 * set-based scan over contacts per tenant represented in the input.
 */
export async function getSegmentMemberCounts(
	db: Database,
	rows: SegmentDefinitionRow[],
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	const dynamicRows: SegmentDefinitionRow[] = [];
	for (const row of rows) {
		if (row.isDynamic) {
			counts.set(row.id, 0);
			dynamicRows.push(row);
		} else {
			counts.set(row.id, row.memberCount);
		}
	}

	for (const [organizationId, organizationSegments] of groupByOrganization(
		dynamicRows,
	)) {
		const values = dynamicMatchValues(organizationSegments);
		const matched = await db.execute<{
			segment_id: string;
			member_count: number;
		}>(sql`
			SELECT dynamic_match.segment_id, count(*)::integer AS member_count
			FROM ${contacts}
			CROSS JOIN LATERAL (
				VALUES ${values}
			) AS dynamic_match(segment_id, is_match)
			WHERE ${contacts.organizationId} = ${organizationId}
				AND dynamic_match.is_match
			GROUP BY dynamic_match.segment_id
		`);
		for (const row of matched) {
			counts.set(row.segment_id, Number(row.member_count));
		}
	}
	return counts;
}

export interface DynamicSegmentPair {
	contactId: string;
	segmentId: string;
}

/** Evaluate all dynamic definitions for a bounded set of already-authorized contacts. */
export async function getDynamicSegmentPairs(
	db: Database,
	organizationId: string,
	contactIds: string[],
	dynamicRows?: SegmentDefinitionRow[],
): Promise<DynamicSegmentPair[]> {
	if (contactIds.length === 0) return [];
	const definitions =
		dynamicRows ??
		(await db
			.select({
				id: segments.id,
				organizationId: segments.organizationId,
				workspaceId: segments.workspaceId,
				scopeKey: segments.scopeKey,
				filter: segments.filter,
				isDynamic: segments.isDynamic,
				memberCount: segments.memberCount,
			})
			.from(segments)
			.where(
				and(
					eq(segments.organizationId, organizationId),
					eq(segments.isDynamic, true),
				),
			));
	const tenantDefinitions = definitions.filter(
		(row) => row.organizationId === organizationId && row.isDynamic,
	);
	if (tenantDefinitions.length === 0) return [];

	const values = dynamicMatchValues(tenantDefinitions);
	const matched = await db.execute<{
		contact_id: string;
		segment_id: string;
	}>(sql`
		SELECT ${contacts.id} AS contact_id, dynamic_match.segment_id
		FROM ${contacts}
		CROSS JOIN LATERAL (
			VALUES ${values}
		) AS dynamic_match(segment_id, is_match)
		WHERE ${contacts.organizationId} = ${organizationId}
			AND ${inArray(contacts.id, contactIds)}
			AND dynamic_match.is_match
	`);
	return matched.map((row) => ({
		contactId: row.contact_id,
		segmentId: row.segment_id,
	}));
}

/**
 * Automation schedule selection for one scope. Unknown, foreign, or
 * cross-workspace segment IDs simply cannot contribute a contact.
 */
export async function getContactsMatchingAnySegment(
	db: Database,
	organizationId: string,
	workspaceId: string | null,
	segmentIds: string[],
): Promise<string[]> {
	if (segmentIds.length === 0) return [];
	const definitions = await db
		.select({
			id: segments.id,
			organizationId: segments.organizationId,
			workspaceId: segments.workspaceId,
			scopeKey: segments.scopeKey,
			filter: segments.filter,
			isDynamic: segments.isDynamic,
			memberCount: segments.memberCount,
		})
		.from(segments)
		.where(
			and(
				eq(segments.organizationId, organizationId),
				workspaceId
					? eq(segments.workspaceId, workspaceId)
					: isNull(segments.workspaceId),
				inArray(segments.id, [...new Set(segmentIds)]),
			),
		);
	if (definitions.length === 0) return [];
	const membership = or(...definitions.map(contactMatchesSegment));
	if (!membership) return [];
	const rows = await db
		.select({ id: contacts.id })
		.from(contacts)
		.where(
			and(
				eq(contacts.organizationId, organizationId),
				workspaceId
					? eq(contacts.workspaceId, workspaceId)
					: isNull(contacts.workspaceId),
				membership,
			),
		);
	return rows.map((row) => row.id);
}
