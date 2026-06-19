import {
	ArrowRight,
	BarChart3,
	Bell,
	BellDot,
	BookOpen,
	Building2,
	Check,
	ChevronRight,
	Code2,
	Flame,
	House,
	Inbox,
	Link2,
	Loader2,
	LogOut,
	MoreHorizontal,
	Moon,
	PenSquare,
	Plus,
	Settings,
	Shield,
	Sparkles,
	Sun,
	Target,
	User,
	Users,
	Workflow,
	X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useStreak } from "@/hooks/use-streak";
import { useUsage } from "@/hooks/use-usage";
import { fetchDashboardBootstrap } from "@/lib/dashboard-bootstrap";
import { scheduleIdleTask } from "@/lib/idle";
import { isModifiedClick } from "@/lib/link-nav";
import { cn } from "@/lib/utils";

async function loadAuthClient() {
	return import("@/lib/auth-client");
}

import type { LucideIcon } from "lucide-react";
import {
	type AppOrganization,
	type AppUser,
	getOrgColor,
	slugify,
} from "@/types/dashboard";

// --- Nav data structure ---

interface NavSubItem {
	label: string;
	href: string;
	badge?: string;
}

interface NavItem {
	label: string;
	icon: LucideIcon;
	href: string;
	badge?: string;
	children?: NavSubItem[];
}

// Grouped, unlabeled sections separated by hairline dividers (mockup Sidebar.jsx).
// Secondary pages are nested as collapsible sub-items to keep the rail compact.
const navSections: NavItem[][] = [
	[
		{ label: "Overview", icon: House, href: "overview" },
		{ label: "Connections", icon: Link2, href: "connections" },
		{
			label: "Inbox",
			icon: Inbox,
			href: "inbox-comments",
			children: [
				{ label: "Comments", href: "inbox-comments" },
				{ label: "Messages", href: "inbox-messages" },
				{ label: "Reviews", href: "inbox-reviews" },
			],
		},
	],
	[
		{
			label: "Posts",
			icon: PenSquare,
			href: "posts",
			children: [
				{ label: "Calendar", href: "posts" },
				{ label: "Scheduling", href: "scheduling" },
				{ label: "Media", href: "media" },
				{ label: "Ideas", href: "ideas" },
				{ label: "Templates", href: "templates" },
			],
		},
		{ label: "Analytics", icon: BarChart3, href: "analytics" },
		{
			label: "Automation",
			icon: Workflow,
			href: "automation",
			children: [
				{ label: "Flows", href: "automation" },
				{ label: "Campaigns", href: "campaigns" },
				{ label: "Broadcasts", href: "broadcasts" },
				{ label: "WhatsApp", href: "whatsapp" },
			],
		},
		{ label: "Contacts", icon: Users, href: "contacts" },
		{ label: "Ads", icon: Target, href: "ads" },
	],
	[
		{
			label: "Developer",
			icon: Code2,
			href: "api-keys",
			children: [
				{ label: "API Keys", href: "api-keys" },
				{ label: "Webhooks", href: "webhooks" },
				{ label: "Logs", href: "logs" },
			],
		},
		{
			label: "Workspace",
			icon: Building2,
			href: "settings",
			children: [
				{ label: "Settings", href: "settings" },
				{ label: "Members", href: "team" },
				{ label: "Usage", href: "usage" },
				{ label: "Billing & Invoices", href: "billing" },
			],
		},
	],
	[{ label: "Notifications", icon: Bell, href: "notifications" }],
];

const allNavItems = navSections.flat();

function getAllChildHrefs(item: NavItem): string[] {
	return item.children?.map((c) => c.href) ?? [];
}

function isChildActive(item: NavItem, currentPage: string): boolean {
	return getAllChildHrefs(item).includes(currentPage);
}

// --- Animation variants ---

const menuVariants = {
	hidden: { opacity: 0, scale: 0.96, y: -4 },
	visible: {
		opacity: 1,
		scale: 1,
		y: 0,
		transition: { duration: 0.12, ease: [0.32, 0.72, 0, 1] as const },
	},
	exit: {
		opacity: 0,
		scale: 0.96,
		y: -4,
		transition: { duration: 0.08, ease: [0.32, 0.72, 0, 1] as const },
	},
};

// --- Component ---

interface SidebarProps {
	currentPage: string;
	onNavigate: (page: string) => void;
	onPrefetch?: (page: string) => void;
	buildHref?: (page: string) => string;
	isOpen: boolean;
	onClose: () => void;
	user?: AppUser | null;
	organization?: AppOrganization | null;
}

interface OrgListItem {
	id: string;
	name: string;
	slug: string;
	logo?: string | null;
}

export function Sidebar({
	currentPage,
	onNavigate,
	onPrefetch,
	buildHref,
	isOpen,
	onClose,
	user,
	organization,
}: SidebarProps) {
	// Overview lives at /app (and /app/overview); everything else at /app/<page>.
	const hrefFor = (page: string) =>
		page === "overview" ? "/app" : (buildHref?.(page) ?? `/app/${page}`);

	// Navigate via onNavigate (programmatic full-document nav) instead of the
	// native <a> default. iOS Safari drops the default navigation when onClose()
	// slides this drawer off-screen mid-tap; programmatic navigation isn't
	// affected. Keep the href (below) for a11y, prefetch, and open-in-new-tab.
	const handleNavClick = (
		e: ReactMouseEvent<HTMLAnchorElement>,
		page: string,
	) => {
		if (isModifiedClick(e)) return; // let the browser open in a new tab
		e.preventDefault();
		onNavigate(page);
	};

	// --- Usage / streak (plan label + upgrade CTA) ---
	const { usage } = useUsage();
	const { streak } = useStreak();
	const plan = usage?.plan || "free";
	const [isCancelling, setIsCancelling] = useState(false);
	const [billingStatusLoaded, setBillingStatusLoaded] = useState(false);

	// --- Theme toggle (light default, scoped via .dash-theme) ---
	const [isDark, setIsDark] = useState(false);
	useEffect(() => {
		setIsDark(document.documentElement.classList.contains("dark"));
	}, []);
	const toggleTheme = () => {
		const next = !document.documentElement.classList.contains("dark");
		document.documentElement.classList.toggle("dark", next);
		try {
			localStorage.setItem("relay_theme", next ? "dark" : "light");
		} catch {
			// ignore
		}
		setIsDark(next);
	};

	// --- Collapsible nav ---
	const [expandedItems, setExpandedItems] = useState<Set<string>>(() => {
		const expanded = new Set<string>();
		for (const item of allNavItems) {
			if (item.children && isChildActive(item, currentPage)) {
				expanded.add(item.label);
			}
		}
		return expanded;
	});

	useEffect(() => {
		setExpandedItems((prev) => {
			const next = new Set(prev);
			for (const item of allNavItems) {
				if (item.children && isChildActive(item, currentPage)) {
					next.add(item.label);
				}
			}
			return next;
		});
	}, [currentPage]);

	const toggleExpand = (item: NavItem) => {
		const wasExpanded = expandedItems.has(item.label);
		setExpandedItems((prev) => {
			const next = new Set(prev);
			if (next.has(item.label)) next.delete(item.label);
			else next.add(item.label);
			return next;
		});
		if (!wasExpanded && item.children?.[0]) {
			onNavigate(item.children[0].href);
		}
	};

	// --- Account menu (consolidated: theme, org switcher, account, sign out) ---
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const orgSearchRef = useRef<HTMLInputElement>(null);

	const [currentOrg, setCurrentOrg] = useState<OrgListItem | null>(
		organization
			? {
					id: organization.id,
					name: organization.name,
					slug: organization.slug,
					logo: organization.logo,
				}
			: null,
	);
	const [orgs, setOrgs] = useState<OrgListItem[]>([]);
	const [orgsLoading, setOrgsLoading] = useState(false);
	const [orgsLoaded, setOrgsLoaded] = useState(false);
	const [orgSearch, setOrgSearch] = useState("");
	const [createOrgOpen, setCreateOrgOpen] = useState(false);
	const [newOrgName, setNewOrgName] = useState("");
	const [newOrgSlug, setNewOrgSlug] = useState("");
	const [newOrgSlugEdited, setNewOrgSlugEdited] = useState(false);
	const [createOrgLoading, setCreateOrgLoading] = useState(false);
	const [createOrgError, setCreateOrgError] = useState<string | null>(null);

	const loadOrganizations = useCallback(async () => {
		setOrgsLoading(true);
		try {
			const { organization: orgClient } = await loadAuthClient();
			const { data } = await orgClient.list();
			if (data) {
				const items: OrgListItem[] = data.map(
					(o: {
						id: string;
						name: string;
						slug: string;
						logo?: string | null;
					}) => ({
						id: o.id,
						name: o.name,
						slug: o.slug,
						logo: o.logo,
					}),
				);
				setOrgs(items);
				setCurrentOrg((prev) =>
					prev ? (items.find((o) => o.id === prev.id) ?? prev) : (items[0] ?? null),
				);
				if (!currentOrg && items[0]) {
					void orgClient.setActive({ organizationId: items[0].id });
				}
			}
		} catch (e) {
			console.error("Failed to fetch organizations:", e);
		} finally {
			setOrgsLoading(false);
			setOrgsLoaded(true);
		}
	}, [currentOrg]);

	useEffect(() => {
		if (!currentOrg && !orgsLoaded && !orgsLoading) {
			void loadOrganizations();
		}
	}, [currentOrg, orgsLoaded, orgsLoading, loadOrganizations]);

	// Load org list + billing status the first time the menu opens.
	useEffect(() => {
		if (!menuOpen) return;
		if (!orgsLoaded && !orgsLoading) void loadOrganizations();
		if (plan === "pro" && !billingStatusLoaded) {
			fetch("/api/billing/status")
				.then((r) => (r.ok ? r.json() : null))
				.then((data) => setIsCancelling(!!data?.subscription?.cancelAtPeriodEnd))
				.catch(() => {})
				.finally(() => setBillingStatusLoaded(true));
		}
	}, [menuOpen, orgsLoaded, orgsLoading, loadOrganizations, plan, billingStatusLoaded]);

	// Click-outside handler for the account menu.
	useEffect(() => {
		if (!menuOpen) return;
		const handleClick = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
				setOrgSearch("");
			}
		};
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [menuOpen]);

	const handleSwitchOrg = async (org: OrgListItem) => {
		setCurrentOrg(org);
		setMenuOpen(false);
		setOrgSearch("");
		const { organization: orgClient } = await loadAuthClient();
		await orgClient.setActive({ organizationId: org.id });
		window.location.href = window.location.pathname;
	};

	// --- Notifications (via WebSocket bootstrap) ---
	const [notifCount, setNotifCount] = useState(0);
	useEffect(() => {
		return scheduleIdleTask(() => {
			void fetchDashboardBootstrap({ orgId: organization?.id ?? null }).then(
				(data) => {
					if (data?.notif_count != null) setNotifCount(data.notif_count);
				},
			);
		}, 1500);
	}, [organization?.id]);

	const userInitials = user?.name
		? user.name
				.split(" ")
				.map((n) => n[0])
				.join("")
				.toUpperCase()
				.slice(0, 2)
		: "?";

	const handleSignOut = async () => {
		const { signOut } = await loadAuthClient();
		await signOut();
		window.location.href = "/login";
	};

	const prefetchItem = (item: NavItem) => {
		if (!onPrefetch) return;
		if (item.children?.[0]) {
			onPrefetch(item.children[0].href);
			return;
		}
		onPrefetch(item.href);
	};

	// --- Render helpers ---

	const renderFlatItem = (item: NavItem) => {
		const isActive = currentPage === item.href;
		// Notifications carries a live, WebSocket-driven count instead of a static badge.
		const badge =
			item.href === "notifications"
				? notifCount > 0
					? notifCount > 99
						? "99+"
						: String(notifCount)
					: undefined
				: item.badge;
		return (
			<a
				key={item.href}
				href={hrefFor(item.href)}
				onClick={(e) => handleNavClick(e, item.href)}
				onMouseEnter={() => onPrefetch?.(item.href)}
				onFocus={() => onPrefetch?.(item.href)}
				className={cn(
					"flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[12.5px] transition-colors ease-[var(--ease-relay)] md:py-1.5",
					isActive
						? "bg-sidebar-accent font-medium text-foreground"
						: "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
				)}
			>
				<item.icon
					className={cn("size-[15px] shrink-0", !isActive && "opacity-90")}
					strokeWidth={1.5}
				/>
				<span className="flex-1 text-left">{item.label}</span>
				{badge && (
					<span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
						{badge}
					</span>
				)}
			</a>
		);
	};

	const renderCollapsibleItem = (item: NavItem) => {
		const isExpanded = expandedItems.has(item.label);
		const hasActiveChild = isChildActive(item, currentPage);

		return (
			<div key={item.label}>
				<button
					type="button"
					onClick={() => toggleExpand(item)}
					onMouseEnter={() => prefetchItem(item)}
					onFocus={() => prefetchItem(item)}
					className={cn(
						"flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[12.5px] transition-colors ease-[var(--ease-relay)] md:py-1.5",
						hasActiveChild
							? "font-medium text-foreground"
							: "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
					)}
				>
					<item.icon className="size-[15px] shrink-0" strokeWidth={1.5} />
					<span className="flex-1 text-left">{item.label}</span>
					<motion.div
						animate={{ rotate: isExpanded ? 90 : 0 }}
						transition={{ duration: 0.15, ease: [0.32, 0.72, 0, 1] }}
					>
						<ChevronRight className="size-3 text-muted-foreground/60" />
					</motion.div>
				</button>

				<AnimatePresence initial={false}>
					{isExpanded && item.children && (
						<motion.div
							initial={{ height: 0, opacity: 0 }}
							animate={{ height: "auto", opacity: 1 }}
							exit={{ height: 0, opacity: 0 }}
							transition={{ duration: 0.15, ease: [0.32, 0.72, 0, 1] }}
							className="overflow-hidden"
						>
							<div className="mt-0.5 ml-[18px] space-y-px border-l border-sidebar-border pl-2.5">
								{item.children.map((child) => {
									const isActive = currentPage === child.href;
									return (
										<a
											key={child.href}
											href={hrefFor(child.href)}
											onClick={(e) => handleNavClick(e, child.href)}
											onMouseEnter={() => onPrefetch?.(child.href)}
											onFocus={() => onPrefetch?.(child.href)}
											className={cn(
												"flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] transition-colors ease-[var(--ease-relay)] md:py-1",
												isActive
													? "bg-sidebar-accent font-medium text-foreground"
													: "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
											)}
										>
											<span>{child.label}</span>
											{child.badge && (
												<span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary">
													{child.badge}
												</span>
											)}
										</a>
									);
								})}
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</div>
		);
	};

	const renderNavItem = (item: NavItem) =>
		item.children ? renderCollapsibleItem(item) : renderFlatItem(item);

	const menuRow =
		"flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-1.5 text-[13px] text-foreground transition-colors hover:bg-accent";

	return (
		<>
			{isOpen && (
				<button
					type="button"
					aria-label="Close menu"
					className="fixed inset-0 z-40 bg-black/50 md:hidden"
					onClick={onClose}
				/>
			)}

			<aside
				className={cn(
					// `md:translate-none` (not `md:translate-x-0`): a non-`none` translate
					// creates a stacking context that would trap the account menu's z-index
					// inside the sidebar, letting positioned content in <main> paint over it.
					"fixed top-0 left-0 z-60 h-dvh w-[85vw] max-w-[320px] shrink-0 border-r border-sidebar-border bg-sidebar transition-transform duration-200 md:static md:z-auto md:h-auto md:w-48 md:max-w-none md:translate-none md:border-r-0",
					isOpen ? "translate-x-0" : "-translate-x-full",
				)}
			>
				<div className="flex h-full flex-col">
					{/* Profile block (top) */}
					<div className="shrink-0 px-3 pt-3 pb-2 md:pt-10 lg:pt-12">
						<div className="flex items-center gap-2.5 px-1">
							{user?.image ? (
								<img
									src={user.image}
									alt={user.name}
									className="size-[30px] shrink-0 rounded-full object-cover"
								/>
							) : (
								<div className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-secondary text-[12px] font-semibold text-foreground">
									{userInitials}
								</div>
							)}
							<div className="min-w-0 flex-1 leading-tight">
								<div className="truncate text-[12.5px] font-semibold">
									{user?.name || "User"}
								</div>
								<div className="flex items-center gap-1 text-[11px] text-muted-foreground">
									<span className="truncate">
										{currentOrg?.name ||
											organization?.name ||
											"Personal"}
									</span>
									{plan === "pro" && (
										<Sparkles
											className="size-3 shrink-0 text-foreground"
											strokeWidth={1.8}
											aria-label={
												isCancelling ? "Pro (ending)" : "Pro"
											}
										/>
									)}
								</div>
							</div>

							<div ref={menuRef} className="relative">
								<button
									type="button"
									aria-label="Account menu"
									title={menuOpen ? undefined : "Account menu"}
									onClick={() => setMenuOpen((o) => !o)}
									className={cn(
										"inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground",
										menuOpen && "bg-sidebar-accent text-foreground",
									)}
								>
									<MoreHorizontal className="size-4" strokeWidth={1.6} />
								</button>

								<AnimatePresence>
									{menuOpen && (
										<motion.div
											variants={menuVariants}
											initial="hidden"
											animate="visible"
											exit="exit"
											className="absolute right-0 top-full z-[70] mt-1.5 w-60 origin-top-right rounded-md border border-border bg-popover p-1.5 shadow-[var(--shadow-popover)] md:right-auto md:left-0 md:origin-top-left"
										>
											<button type="button" className={menuRow} onClick={toggleTheme}>
												{isDark ? (
													<Sun className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.6} />
												) : (
													<Moon className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.6} />
												)}
												<span>{isDark ? "Light mode" : "Dark mode"}</span>
											</button>
											<button
												type="button"
												className={menuRow}
												onClick={() => {
													onNavigate("settings");
													setMenuOpen(false);
												}}
											>
												<Settings className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.6} />
												<span>Account settings</span>
											</button>
											<button
												type="button"
												className={menuRow}
												onClick={() => {
													onNavigate("profile");
													setMenuOpen(false);
												}}
											>
												<User className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.6} />
												<span>Profile</span>
											</button>

											<div className="my-1.5 h-px bg-border" />
											<div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
												Organizations
											</div>
											{orgsLoading ? (
												<div className="flex items-center justify-center py-3">
													<Loader2 className="size-4 animate-spin text-muted-foreground" />
												</div>
											) : (
												<>
													{orgs.length > 5 && (
														<div className="px-1 pb-1">
															<input
																ref={orgSearchRef}
																type="text"
																placeholder="Search organizations..."
																value={orgSearch}
																onChange={(e) => setOrgSearch(e.target.value)}
																className="w-full rounded border border-border bg-background px-2 py-1 text-[12px] outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
															/>
														</div>
													)}
													<div className="max-h-[180px] overflow-y-auto">
														{orgs
															.filter(
																(org) =>
																	!orgSearch ||
																	org.name
																		.toLowerCase()
																		.includes(orgSearch.toLowerCase()),
															)
															.map((org) => (
																<button
																	type="button"
																	key={org.id}
																	onClick={() => handleSwitchOrg(org)}
																	className={menuRow}
																>
																	{org.logo ? (
																		<img
																			src={org.logo}
																			alt={org.name}
																			className="size-5 shrink-0 rounded object-cover"
																		/>
																	) : (
																		<div
																			className={cn(
																				"flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white",
																				getOrgColor(org.id),
																			)}
																		>
																			{org.name.charAt(0).toUpperCase()}
																		</div>
																	)}
																	<span className="flex-1 truncate text-left">
																		{org.name}
																	</span>
																	{org.id === currentOrg?.id && (
																		<Check className="size-3.5 shrink-0 text-foreground" />
																	)}
																</button>
															))}
													</div>
												</>
											)}
											<button
												type="button"
												onClick={() => {
													setMenuOpen(false);
													setCreateOrgOpen(true);
												}}
												className={cn(menuRow, "text-muted-foreground")}
											>
												<Plus className="size-[15px] shrink-0" strokeWidth={1.6} />
												<span>Create organization</span>
											</button>

											{plan !== "pro" && (
												<button
													type="button"
													onClick={() => {
														onNavigate("billing");
														setMenuOpen(false);
													}}
													className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-[6px] bg-accent py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-sidebar-accent"
												>
													<Sparkles className="size-3.5" />
													Upgrade plan
												</button>
											)}

											<div className="my-1.5 h-px bg-border" />
											<a
												href="https://docs.relayapi.dev/"
												target="_blank"
												rel="noopener noreferrer"
												className={menuRow}
											>
												<BookOpen className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.6} />
												<span>Documentation</span>
											</a>
											<button
												type="button"
												onClick={() => {
													const prevParams = new URLSearchParams(
														window.location.search,
													);
													const nextParams = new URLSearchParams();
													for (const key of ["workspace", "account"]) {
														const value = prevParams.get(key);
														if (value) nextParams.set(key, value);
													}
													nextParams.set("tab", "notifications");
													window.location.assign(`/app/settings?${nextParams}`);
													setMenuOpen(false);
												}}
												className={menuRow}
											>
												<BellDot className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.6} />
												<span>Notification preferences</span>
											</button>
											{user?.role === "admin" && (
												<button
													type="button"
													onClick={() => {
														onNavigate("admin-users");
														setMenuOpen(false);
													}}
													className={menuRow}
												>
													<Shield className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.6} />
													<span>Admin</span>
												</button>
											)}

											<div className="my-1.5 h-px bg-border" />
											<button type="button" onClick={handleSignOut} className={menuRow}>
												<LogOut className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.6} />
												<span>Sign out</span>
											</button>
										</motion.div>
									)}
								</AnimatePresence>
							</div>

							<button
								type="button"
								className="ml-0.5 rounded p-1 hover:bg-sidebar-accent md:hidden"
								onClick={onClose}
							>
								<X className="size-3.5" />
							</button>
						</div>
					</div>

					{/* Navigation */}
					<ScrollArea className="min-h-0 flex-1">
						<nav className="px-3 py-1">
							{navSections.map((section, si) => (
								<Fragment key={section[0]?.href ?? si}>
									{si > 0 && (
										<div className="mx-2.5 my-2 h-px bg-sidebar-border" />
									)}
									<div className="space-y-0.5">
										{section.map(renderNavItem)}
									</div>
								</Fragment>
							))}
						</nav>
					</ScrollArea>

					{/* Footer: posting streak (Notifications now lives inline in the nav) */}
					{streak?.active && streak.current_streak_days > 0 && (
						<div className="shrink-0 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
							<div
								className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px]"
								title={`${streak.current_streak_days}-day posting streak! Best: ${streak.best_streak_days} days.`}
							>
								<Flame
									className={cn(
										"size-4 shrink-0",
										streak.hours_remaining != null &&
											streak.hours_remaining < 2
											? "animate-pulse text-red-400"
											: "text-amber-500",
									)}
								/>
								<span
									className={cn(
										"font-semibold",
										streak.hours_remaining != null &&
											streak.hours_remaining < 2
											? "text-red-400"
											: "text-amber-500",
									)}
								>
									{streak.current_streak_days}d streak
								</span>
							</div>
						</div>
					)}
				</div>
			</aside>

			{/* Create Org Dialog */}
			<Dialog
				open={createOrgOpen}
				onOpenChange={(open) => {
					setCreateOrgOpen(open);
					if (!open) {
						setNewOrgName("");
						setNewOrgSlug("");
						setNewOrgSlugEdited(false);
						setCreateOrgError(null);
					}
				}}
			>
				<DialogContent className="sm:max-w-[420px]">
					<DialogHeader>
						<DialogTitle>Create organization</DialogTitle>
						<DialogDescription>
							Organizations help you manage API keys, connections, and team
							members separately.
						</DialogDescription>
					</DialogHeader>
					<form
						onSubmit={async (e) => {
							e.preventDefault();
							setCreateOrgError(null);
							setCreateOrgLoading(true);
							try {
								const { organization: orgClient } = await loadAuthClient();
								const { data, error: createError } = await orgClient.create({
									name: newOrgName.trim(),
									slug: newOrgSlug.trim(),
								});
								if (createError) {
									setCreateOrgError(
										createError.message || "Failed to create organization",
									);
									setCreateOrgLoading(false);
									return;
								}
								if (data?.id) {
									await orgClient.setActive({ organizationId: data.id });
									try {
										await fetch("/api/bootstrap-key", { method: "POST" });
									} catch {
										// Non-critical
									}
								}
								window.location.href = "/app";
							} catch {
								setCreateOrgError("Something went wrong. Please try again.");
								setCreateOrgLoading(false);
							}
						}}
						className="space-y-4"
					>
						{createOrgError && (
							<div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
								{createOrgError}
							</div>
						)}

						<div className="space-y-1.5">
							<label
								htmlFor="new-org-name"
								className="text-xs font-medium text-muted-foreground"
							>
								Organization name
							</label>
							<input
								id="new-org-name"
								type="text"
								value={newOrgName}
								onChange={(e) => {
									setNewOrgName(e.target.value);
									if (!newOrgSlugEdited) {
										setNewOrgSlug(slugify(e.target.value));
									}
								}}
								placeholder="My Company"
								required
								autoFocus
								className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 transition-colors focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/25"
							/>
						</div>

						<div className="space-y-1.5">
							<label
								htmlFor="new-org-slug"
								className="text-xs font-medium text-muted-foreground"
							>
								URL slug
							</label>
							<input
								id="new-org-slug"
								type="text"
								value={newOrgSlug}
								onChange={(e) => {
									setNewOrgSlug(slugify(e.target.value));
									setNewOrgSlugEdited(true);
								}}
								placeholder="my-company"
								required
								pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
								className="w-full rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 transition-colors focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/25"
							/>
							{newOrgSlug && (
								<p className="text-[11px] text-muted-foreground">
									relayapi.dev/org/{newOrgSlug}
								</p>
							)}
						</div>

						<Button
							type="submit"
							className="w-full"
							disabled={
								createOrgLoading || !newOrgName.trim() || !newOrgSlug.trim()
							}
						>
							{createOrgLoading ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<span className="flex items-center gap-2">
									Create organization
									<ArrowRight className="size-3.5" />
								</span>
							)}
						</Button>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
