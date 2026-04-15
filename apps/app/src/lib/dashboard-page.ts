import { API_BASE_URL } from "./api-base-url";
import { buildApiRequestKey, type ApiQuery } from "./api-request-key";
import { getRelayClient } from "./relay";
import type { AppOrganization, AppUser } from "@/types/dashboard";

interface ListResponse<T> {
	data?: T[];
	has_more?: boolean;
	next_cursor?: string | null;
}

export interface DashboardRouteContext {
	user: AppUser | null;
	organization: AppOrganization | null;
	initialWorkspaceId: string | null;
	initialAccountId: string | null;
}

export interface InitialPaginatedData<T = unknown> {
	data: T[];
	hasMore: boolean;
	nextCursor: string | null;
	requestKey: string;
}

export interface InitialApiData<T = unknown> {
	data: T;
	requestKey: string;
}

function toAppUser(user: App.Locals["user"]): AppUser | null {
	if (!user) return null;

	return {
		id: user.id as string,
		name: user.name as string,
		email: user.email as string,
		image: (user.image as string) || null,
		role: (user.role as string) || null,
	};
}

function toAppOrganization(
	organization: App.Locals["organization"],
): AppOrganization | null {
	if (!organization) return null;

	return {
		id: organization.id as string,
		name: organization.name as string,
		slug: organization.slug as string,
		logo: (organization.logo as string) || null,
	};
}

function getDashboardClient(locals: App.Locals) {
	return getRelayClient(locals, API_BASE_URL);
}

export function getDashboardRouteContext(
	locals: App.Locals,
	url: URL,
): DashboardRouteContext {
	return {
		user: toAppUser(locals.user),
		organization: toAppOrganization(locals.organization),
		initialWorkspaceId: url.searchParams.get("workspace"),
		initialAccountId: url.searchParams.get("account"),
	};
}

export function getSearchParamValue<const T extends string>(
	url: URL,
	key: string,
	allowed: readonly T[],
	fallback: T,
): T {
	const value = url.searchParams.get(key);
	if (value && (allowed as readonly string[]).includes(value)) {
		return value as T;
	}
	return fallback;
}

export function getDashboardFilterQuery(url: URL): ApiQuery {
	const workspaceId = url.searchParams.get("workspace");
	const accountId = url.searchParams.get("account");

	if (accountId) {
		return { account_id: accountId };
	}

	if (workspaceId) {
		return { workspace_id: workspaceId };
	}

	return {};
}

function createInitialPaginatedData<T>(
	path: string,
	query: ApiQuery,
	response: ListResponse<T>,
	limit: number = 20,
): InitialPaginatedData<T> {
	return {
		data: Array.isArray(response?.data) ? response.data : [],
		hasMore: !!response?.has_more,
		nextCursor:
			typeof response?.next_cursor === "string" ? response.next_cursor : null,
		requestKey: buildApiRequestKey(path, { limit, ...query }) || path,
	};
}

function createInitialApiData<T>(
	path: string,
	query: ApiQuery,
	data: T,
): InitialApiData<T> {
	return {
		data,
		requestKey: buildApiRequestKey(path, query) || path,
	};
}

type PostsTab = "all" | "queue" | "drafts" | "published";
type PostsViewMode = "list" | "calendar";
type CalendarPeriod = "week" | "month";

export async function getPostsPageInitialProps(
	locals: App.Locals,
	url: URL,
): Promise<Record<string, unknown>> {
	const initialTab = getSearchParamValue(
		url,
		"tab",
		["all", "queue", "drafts", "published", "sent"] as const,
		"all",
	);
	const normalizedTab: PostsTab =
		initialTab === "sent" ? "published" : initialTab;
	const initialViewMode = getSearchParamValue(
		url,
		"view",
		["list", "calendar"] as const,
		"calendar",
	);
	const initialCalendarPeriod = getSearchParamValue(
		url,
		"period",
		["week", "month"] as const,
		"week",
	);
	const client = await getDashboardClient(locals);

	const props: Record<string, unknown> = {
		initialTab: normalizedTab,
		initialViewMode: initialViewMode as PostsViewMode,
		initialCalendarPeriod: initialCalendarPeriod as CalendarPeriod,
	};

	if (!client) return props;

	const filterQuery = getDashboardFilterQuery(url);

	try {
		switch (normalizedTab) {
			case "queue": {
				const [queueData, failedData] = await Promise.all([
					client.posts.list({
						limit: 20,
						...filterQuery,
						status: "scheduled",
						include: "targets,media",
					}),
					client.posts.list({
						limit: 20,
						...filterQuery,
						status: "failed",
						include: "targets,media",
					}),
				]);
				props.initialQueueData = createInitialPaginatedData(
					"posts",
					{ ...filterQuery, status: "scheduled", include: "targets,media" },
					queueData,
				);
				props.initialFailedData = createInitialPaginatedData(
					"posts",
					{ ...filterQuery, status: "failed", include: "targets,media" },
					failedData,
				);
				break;
			}
			case "drafts": {
				const draftData = await client.posts.list({
					limit: 20,
					...filterQuery,
					status: "draft",
					include: "targets,media",
				});
				props.initialDraftsData = createInitialPaginatedData(
					"posts",
					{ ...filterQuery, status: "draft", include: "targets,media" },
					draftData,
				);
				break;
			}
			case "published": {
				const publishedData = await client.posts.list({
					limit: 20,
					...filterQuery,
					status: "published",
					include: "targets,media",
					include_external: "true",
				});
				props.initialPublishedData = createInitialPaginatedData(
					"posts",
					{
						...filterQuery,
						status: "published",
						include: "targets,media",
						include_external: "true",
					},
					publishedData,
				);
				break;
			}
			default: {
				const allData = await client.posts.list({
					limit: 20,
					...filterQuery,
					include: "targets,media",
					include_external: "true",
				});
				props.initialAllData = createInitialPaginatedData(
					"posts",
					{
						...filterQuery,
						include: "targets,media",
						include_external: "true",
					},
					allData,
				);
				break;
			}
		}
	} catch (error) {
		console.error("Failed to preload posts page data:", error);
	}

	return props;
}

type ConnectionsTab =
	| "accounts"
	| "connect"
	| "workspaces"
	| "health"
	| "logs";

export async function getConnectionsPageInitialProps(
	locals: App.Locals,
	url: URL,
): Promise<Record<string, unknown>> {
	const initialTab = getSearchParamValue(
		url,
		"tab",
		["accounts", "connect", "workspaces", "health", "logs"] as const,
		"accounts",
	) as ConnectionsTab;
	const client = await getDashboardClient(locals);
	const props: Record<string, unknown> = { initialTab };

	if (!client || initialTab === "connect") return props;

	try {
		if (initialTab === "accounts") {
			const workspaceId = url.searchParams.get("workspace");
			const accountsQuery: ApiQuery = {};
			if (workspaceId === "__ungrouped") {
				accountsQuery.ungrouped = true;
			} else if (workspaceId) {
				accountsQuery.workspace_id = workspaceId;
			}

			const accountsData = await client.accounts.list({
				limit: 20,
				...accountsQuery,
			});
			props.initialAccountsData = createInitialPaginatedData(
				"accounts",
				accountsQuery,
				accountsData,
			);
		}

		if (initialTab === "health") {
			const healthData = await client.accounts.health.list({ limit: 20 });
			props.initialHealthData = createInitialPaginatedData(
				"accounts/health",
				{},
				healthData,
			);
		}

		if (initialTab === "logs") {
			const logsData = await client.connections.listLogs({ limit: 20 });
			props.initialLogsData = createInitialPaginatedData(
				"connections/logs",
				{},
				logsData,
			);
		}

		if (initialTab === "workspaces") {
			const workspacesData = await client.workspaces.list({ limit: 20 });
			props.initialWorkspacesData = createInitialPaginatedData(
				"workspaces",
				{},
				workspacesData,
			);
		}
	} catch (error) {
		console.error("Failed to preload connections page data:", error);
	}

	return props;
}

type DatePreset = "7d" | "30d" | "90d" | "year";

function getAnalyticsDateRange(preset: DatePreset): { from: string; to: string } {
	const to = new Date();
	const from = new Date();

	switch (preset) {
		case "7d":
			from.setDate(from.getDate() - 7);
			break;
		case "30d":
			from.setDate(from.getDate() - 30);
			break;
		case "90d":
			from.setDate(from.getDate() - 90);
			break;
		case "year":
			from.setMonth(0, 1);
			break;
	}

	return {
		from: from.toISOString().split("T")[0]!,
		to: to.toISOString().split("T")[0]!,
	};
}

function getAnalyticsDatePreset(url: URL): DatePreset {
	const fromParam = url.searchParams.get("from");
	const toParam = url.searchParams.get("to");

	if (fromParam && toParam) {
		for (const preset of ["7d", "30d", "90d", "year"] as const) {
			const range = getAnalyticsDateRange(preset);
			if (range.from === fromParam && range.to === toParam) {
				return preset;
			}
		}
	}

	return "30d";
}

export async function getAnalyticsPageInitialProps(
	locals: App.Locals,
	url: URL,
): Promise<Record<string, unknown>> {
	const initialDatePreset = getAnalyticsDatePreset(url);
	const dateRange = getAnalyticsDateRange(initialDatePreset);
	const client = await getDashboardClient(locals);

	const props: Record<string, unknown> = {
		initialSelectedChannel: url.searchParams.get("channel"),
		initialDatePreset,
	};

	if (!client) return props;

	try {
		const channelsData = await (client as any).get("/v1/analytics/channels", {
			query: {
				from_date: dateRange.from,
				to_date: dateRange.to,
			},
		});
		props.initialChannelsData = createInitialApiData(
			"analytics/channels",
			{ from_date: dateRange.from, to_date: dateRange.to },
			channelsData,
		);
	} catch (error) {
		console.error("Failed to preload analytics page data:", error);
	}

	return props;
}
