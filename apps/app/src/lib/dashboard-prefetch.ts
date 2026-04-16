const prefetchers: Record<string, () => Promise<unknown>> = {
	ideas: () => import("../components/dashboard/pages/ideas-page"),
	connections: () => import("../components/dashboard/pages/connections-page"),
	posts: () => import("../components/dashboard/pages/posts-page"),
	media: () => import("../components/dashboard/pages/media-page"),
	scheduling: () => import("../components/dashboard/pages/scheduling-page"),
	analytics: () =>
		import("../components/dashboard/pages/analytics/analytics-page-new"),
	"inbox-comments": () =>
		import("../components/dashboard/pages/inbox-comments-page"),
	"inbox-messages": () =>
		import("../components/dashboard/pages/inbox-messages-page"),
	"inbox-reviews": () =>
		import("../components/dashboard/pages/inbox-reviews-page"),
	contacts: () => import("../components/dashboard/pages/contacts-page"),
	templates: () => import("../components/dashboard/pages/templates-page"),
	campaigns: () => import("../components/dashboard/pages/campaigns-page"),
	whatsapp: () => import("../components/dashboard/pages/whatsapp-page"),
	ads: () => import("../components/dashboard/pages/ads-page"),
	"api-keys": () => import("../components/dashboard/pages/api-keys-page"),
	webhooks: () => import("../components/dashboard/pages/webhooks-page"),
	logs: () => import("../components/dashboard/pages/logs-page"),
	team: () => import("../components/dashboard/pages/team-page"),
	billing: () => import("../components/dashboard/pages/billing-page"),
	settings: () => import("../components/dashboard/pages/settings-page"),
	notifications: () =>
		import("../components/dashboard/pages/notifications-page"),
	profile: () => import("../components/dashboard/pages/profile-page"),
	"admin-users": () =>
		import("../components/dashboard/pages/admin/admin-users-page"),
	"admin-organizations": () =>
		import("../components/dashboard/pages/admin/admin-organizations-page"),
	"admin-plans": () =>
		import("../components/dashboard/pages/admin/admin-plans-page"),
};

type NetworkInformationLike = {
	saveData?: boolean;
	effectiveType?: string;
};

const prefetchedPages = new Set<string>();
const prefetchedDocuments = new Set<string>();

function shouldPrefetchDocument(): boolean {
	if (typeof navigator === "undefined") return false;

	const connection = (
		navigator as Navigator & { connection?: NetworkInformationLike }
	).connection;
	if (connection?.saveData) return false;
	if (connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g") {
		return false;
	}

	return typeof document !== "undefined";
}

function prefetchDashboardDocument(url: string): void {
	if (!shouldPrefetchDocument()) return;
	if (prefetchedDocuments.has(url)) return;

	prefetchedDocuments.add(url);

	try {
		const link = document.createElement("link");
		link.rel = "prefetch";
		link.as = "document";
		link.href = url;
		link.onload = () => {
			link.onload = null;
		};
		link.onerror = () => {
			prefetchedDocuments.delete(url);
			link.remove();
		};
		document.head.append(link);
	} catch {
		prefetchedDocuments.delete(url);
	}
}

export function prefetchDashboardPage(page: string, url?: string): void {
	if (typeof window === "undefined") return;

	const prefetch = prefetchers[page];
	if (!prefetch && !url) return;

	if (url) {
		prefetchDashboardDocument(url);
	}

	if (!prefetch || prefetchedPages.has(page)) return;

	prefetchedPages.add(page);
	void prefetch().catch(() => {
		prefetchedPages.delete(page);
	});
}
