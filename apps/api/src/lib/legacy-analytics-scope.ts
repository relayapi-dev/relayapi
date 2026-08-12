import { posts, postTargets } from "@relayapi/db";
import { eq, gte, isNull, lte, type SQL } from "drizzle-orm";
import type { Variables } from "../types";
import { workspaceScopeSqlCondition } from "./workspace-scope";

export interface LegacyAnalyticsScope {
	organizationId: string;
	workspaceScope: Variables["workspaceScope"];
	workspaceId?: string | null;
	accountId?: string;
	postId?: string;
	platform?: string;
	fromDate?: Date;
	toDate?: Date;
}

/**
 * Every legacy analytics query derives tenant access from the owning post.
 * post_targets has no independent workspace column, so posts.workspace_id is
 * the single authoritative scope boundary for both list and aggregate paths.
 */
export function legacyAnalyticsConditions(input: LegacyAnalyticsScope): SQL[] {
	const conditions: SQL[] = [
		eq(posts.organizationId, input.organizationId),
		workspaceScopeSqlCondition(input.workspaceScope, posts.workspaceId),
	];

	if (input.workspaceId !== undefined) {
		conditions.push(
			input.workspaceId === null
				? isNull(posts.workspaceId)
				: eq(posts.workspaceId, input.workspaceId),
		);
	}
	if (input.accountId) {
		conditions.push(eq(postTargets.socialAccountId, input.accountId));
	}
	if (input.postId) conditions.push(eq(posts.id, input.postId));
	if (input.platform) {
		conditions.push(eq(postTargets.platform, input.platform as never));
	}
	if (input.fromDate) conditions.push(gte(posts.publishedAt, input.fromDate));
	if (input.toDate) conditions.push(lte(posts.publishedAt, input.toDate));

	return conditions;
}
