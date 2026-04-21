// Binding tabs for the per-account detail page — Plan 3 Unit C3, Task T1.
//
// Renders the tab bar filtered by channel (spec §13.5) and dispatches to the
// per-tab editors (T2-T5). `initialTab` is read from the URL by the parent
// page; `onTabChange` lets the parent mirror the active tab back into the URL
// without triggering a navigation.

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { ConversationStarterTab } from "./conversation-starter";
import { DefaultReplyTab } from "./default-reply";
import { IceBreakerTab } from "./ice-breaker";
import { MainMenuTab } from "./main-menu";
import {
	bindingTabsForChannel,
	findBindingTab,
	type BindingChannel,
} from "./types";
import { WelcomeMessageTab } from "./welcome-message";

interface Props {
	socialAccount: {
		id: string;
		channel: BindingChannel;
		handle: string;
		display_name?: string;
	};
	initialTab?: string;
	onTabChange?: (tab: string) => void;
}

export function BindingsTab({ socialAccount, initialTab, onTabChange }: Props) {
	const tabs = useMemo(
		() => bindingTabsForChannel(socialAccount.channel),
		[socialAccount.channel],
	);

	const [activeKey, setActiveKey] = useState<string>(() => {
		const resolved = findBindingTab(initialTab);
		if (resolved && tabs.some((t) => t.key === resolved.key)) {
			return resolved.key;
		}
		return tabs[0]?.key ?? "";
	});

	// If the channel changes and the active tab becomes unavailable, reset.
	useEffect(() => {
		if (!tabs.some((t) => t.key === activeKey)) {
			const fallback = tabs[0]?.key ?? "";
			setActiveKey(fallback);
			if (fallback) onTabChange?.(fallback);
		}
	}, [tabs, activeKey, onTabChange]);

	const select = (key: string) => {
		setActiveKey(key);
		onTabChange?.(key);
	};

	if (tabs.length === 0) {
		// Defensive — for the 5 supported channels this never hits because
		// Default Reply + Welcome Message are always in the list.
		return (
			<div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
				No automation bindings are available on this channel yet.
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-end gap-4 border-b border-border overflow-x-auto [&::-webkit-scrollbar]:hidden">
				{tabs.map((tab) => (
					<button
						key={tab.key}
						type="button"
						onClick={() => select(tab.key)}
						className={cn(
							"pb-2 text-[13px] font-medium transition-colors whitespace-nowrap border-b-2 -mb-px",
							activeKey === tab.key
								? "border-foreground text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground",
						)}
					>
						{tab.label}
						{tab.stubbed && (
							<span className="ml-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0 text-[9px] font-medium text-amber-600">
								v1.1
							</span>
						)}
					</button>
				))}
			</div>

			<div>
				{activeKey === "default-reply" && (
					<DefaultReplyTab
						socialAccountId={socialAccount.id}
						channel={socialAccount.channel}
					/>
				)}
				{activeKey === "welcome-message" && (
					<WelcomeMessageTab
						socialAccountId={socialAccount.id}
						channel={socialAccount.channel}
					/>
				)}
				{activeKey === "main-menu" && (
					(socialAccount.channel === "facebook" ||
						socialAccount.channel === "instagram") && (
						<MainMenuTab
							socialAccountId={socialAccount.id}
							channel={socialAccount.channel}
						/>
					)
				)}
				{activeKey === "conversation-starter" &&
					socialAccount.channel === "facebook" && (
						<ConversationStarterTab socialAccountId={socialAccount.id} />
					)}
				{activeKey === "ice-breaker" &&
					socialAccount.channel === "whatsapp" && (
						<IceBreakerTab socialAccountId={socialAccount.id} />
					)}
			</div>
		</div>
	);
}
