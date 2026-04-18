import type { AppOrganization, AppUser } from "@/types/dashboard";

export interface DashboardRouteContext {
	user: AppUser | null;
	organization: AppOrganization | null;
	isImpersonating: boolean;
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

export function getDashboardRouteContext(
	locals: App.Locals,
	url: URL,
): DashboardRouteContext {
	return {
		user: toAppUser(locals.user),
		organization: toAppOrganization(locals.organization),
		isImpersonating: !!locals.session?.impersonatedBy,
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

type PostsTab = "all" | "queue" | "drafts" | "published";
type PostsViewMode = "list" | "calendar";
type CalendarPeriod = "week" | "month";

export function getPostsPageRouteState(url: URL): Record<string, unknown> {
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
		"month",
	);

	return {
		initialTab: normalizedTab,
		initialViewMode: initialViewMode as PostsViewMode,
		initialCalendarPeriod: initialCalendarPeriod as CalendarPeriod,
	};
}

export type ConnectionsTab =
	| "accounts"
	| "connect"
	| "workspaces"
	| "health"
	| "logs";

export interface ConnectionsPageRouteState {
	initialTab: ConnectionsTab;
}

export function getConnectionsPageRouteState(
	url: URL,
): ConnectionsPageRouteState {
	return {
		initialTab: getSearchParamValue(
		url,
		"tab",
		["accounts", "connect", "workspaces", "health", "logs"] as const,
		"accounts",
		) as ConnectionsTab,
	};
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

export function getAnalyticsPageRouteState(
	url: URL,
): Record<string, unknown> {
	return {
		initialSelectedChannel: url.searchParams.get("channel"),
		initialDatePreset: getAnalyticsDatePreset(url),
	};
}
