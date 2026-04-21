// Per-account detail page — Plan 3 Unit C3, Task T6.
//
// Hosts the new binding tabs (default reply, welcome message, main menu,
// conversation starter, ice breaker). Channel-filtered by the account's
// platform per spec §13.5. `?tab=X` deep-links into the right tab and
// replaceState keeps the URL in sync as the operator clicks around.
//
// Deep-link target for the flow detail page's bindings panel:
//   /app/connections/{social_account_id}?tab=default-reply

import { ArrowLeft, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BindingsTab } from "@/components/dashboard/automation/bindings-tab";
import type { BindingChannel } from "@/components/dashboard/automation/bindings-tab/types";
import { useApi } from "@/hooks/use-api";
import {
	platformAvatars,
	platformColors,
	platformLabels,
} from "@/lib/platform-maps";
import { cn } from "@/lib/utils";

interface AccountResponse {
	id: string;
	platform: string;
	username: string | null;
	display_name: string | null;
	avatar_url: string | null;
	workspace: { id: string; name: string } | null;
	connected_at: string;
	updated_at: string;
}

interface Props {
	accountId: string;
	initialTab?: string;
}

// Maps the API's `platform` value to the 5 channels that carry bindings.
// Channels that don't appear in this map (twitter, youtube, linkedin, etc.)
// get a "no bindings supported" empty state.
function platformToChannel(platform: string): BindingChannel | null {
	switch (platform.toLowerCase()) {
		case "instagram":
			return "instagram";
		case "facebook":
			return "facebook";
		case "whatsapp":
			return "whatsapp";
		case "telegram":
			return "telegram";
		case "tiktok":
			return "tiktok";
		default:
			return null;
	}
}

export function ConnectionDetailPage({ accountId, initialTab }: Props) {
	const { data: account, loading, error } = useApi<AccountResponse>(
		`accounts/${accountId}`,
	);

	const channel = useMemo(
		() => (account ? platformToChannel(account.platform) : null),
		[account],
	);

	const [activeTab, setActiveTab] = useState<string | undefined>(initialTab);

	const handleTabChange = useCallback((key: string) => {
		setActiveTab(key);
		if (typeof window === "undefined") return;
		try {
			const url = new URL(window.location.href);
			url.searchParams.set("tab", key);
			const qs = url.searchParams.toString();
			const next = `${url.pathname}${qs ? `?${qs}` : ""}${url.hash}`;
			window.history.replaceState(window.history.state, "", next);
		} catch {
			// ignore
		}
	}, []);

	useEffect(() => {
		// If the URL tab is out of sync (e.g. after ?tab= not matching), reflect
		// the component's first-tab fallback back into the URL so a refresh keeps
		// the user on the right tab.
		if (!activeTab || typeof window === "undefined") return;
		try {
			const url = new URL(window.location.href);
			if (url.searchParams.get("tab") !== activeTab) {
				url.searchParams.set("tab", activeTab);
				const qs = url.searchParams.toString();
				const next = `${url.pathname}${qs ? `?${qs}` : ""}${url.hash}`;
				window.history.replaceState(window.history.state, "", next);
			}
		} catch {}
	}, [activeTab]);

	if (loading) {
		return (
			<div className="flex items-center justify-center py-20">
				<Loader2 className="size-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (error || !account) {
		return (
			<div className="space-y-4">
				<BackLink />
				<div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
					{error ?? "Account not found"}
				</div>
			</div>
		);
	}

	const platform = account.platform.toLowerCase();
	const title =
		account.display_name || account.username || platformLabels[platform] || account.platform;
	const handle = account.username ?? account.display_name ?? account.id.slice(-6);

	return (
		<div className="space-y-6">
			<BackLink />

			{/* Header card */}
			<div className="flex items-center gap-4 rounded-md border border-border bg-card/30 p-4">
				{account.avatar_url ? (
					<img
						src={account.avatar_url}
						alt=""
						className="size-10 rounded-md object-cover"
					/>
				) : (
					<div
						className={cn(
							"flex size-10 items-center justify-center rounded-md text-xs font-bold text-white",
							platformColors[platform] || "bg-neutral-700",
						)}
					>
						{platformAvatars[platform] || platform.slice(0, 2).toUpperCase()}
					</div>
				)}
				<div className="min-w-0">
					<h1 className="text-base font-medium truncate">{title}</h1>
					<p className="text-xs text-muted-foreground truncate">
						{platformLabels[platform] || account.platform}
						{account.username ? ` · @${account.username.replace(/^@/, "")}` : ""}
						{account.workspace ? ` · ${account.workspace.name}` : ""}
					</p>
				</div>
			</div>

			{/* Binding tabs */}
			{channel ? (
				<BindingsTab
					socialAccount={{
						id: account.id,
						channel,
						handle: handle.startsWith("@") ? handle : `@${handle}`,
						display_name: account.display_name ?? undefined,
					}}
					initialTab={activeTab}
					onTabChange={handleTabChange}
				/>
			) : (
				<div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
					Automation bindings aren&rsquo;t available on{" "}
					{platformLabels[platform] || account.platform} accounts yet.
				</div>
			)}
		</div>
	);
}

function BackLink() {
	return (
		<a
			href="/app/connections"
			className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
		>
			<ArrowLeft className="size-3.5" />
			Back to connections
		</a>
	);
}
