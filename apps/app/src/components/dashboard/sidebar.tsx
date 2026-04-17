import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
	PenSquare,
	Link2,
	Inbox,
	MessageCircle,
	BarChart3,
	Key,
	Webhook,
	FileText,
	Users,
	CreditCard,
	Flame,
	X,
	Sparkles,
	BookOpen,
	Bell,
	ChevronRight,
	ChevronsUpDown,
	Check,
	Plus,
	Loader2,
	ArrowRight,
	User,
	BellDot,
	Shield,
	LogOut,
	Settings,
	Megaphone,
	Target,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchDashboardBootstrap } from "@/lib/dashboard-bootstrap";
import { useStreak } from "@/hooks/use-streak";
import { useUsage } from "@/hooks/use-usage";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { scheduleIdleTask } from "@/lib/idle";

async function loadAuthClient() {
	return import("@/lib/auth-client");
}
import type { LucideIcon } from "lucide-react";
import {
	type AppOrganization,
	type AppUser,
	getOrgColor,
	slugify,
	formatNumber,
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

const navItems: NavItem[] = [
	{ label: "Connections", icon: Link2, href: "connections" },
	{ label: "Ideas", icon: Sparkles, href: "ideas" },
	{
		label: "Posts",
		icon: PenSquare,
		href: "posts",
		children: [
			{ label: "Overview", href: "posts" },
			{ label: "Media", href: "media" },
			{ label: "Scheduling", href: "scheduling" },
		],
	},
	{ label: "Analytics", icon: BarChart3, href: "analytics" },
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
	{ label: "Contacts", icon: Users, href: "contacts" },
	{ label: "Templates", icon: FileText, href: "templates" },
	{ label: "Campaigns", icon: Megaphone, href: "campaigns" },
	{ label: "WhatsApp", icon: MessageCircle, href: "whatsapp" },
	{ label: "Ads", icon: Target, href: "ads" },
	{ label: "API Keys", icon: Key, href: "api-keys" },
	{ label: "Webhooks", icon: Webhook, href: "webhooks" },
	{ label: "Logs", icon: FileText, href: "logs" },
	{ label: "Team", icon: Users, href: "team" },
	{ label: "Billing", icon: CreditCard, href: "billing" },
	{ label: "Settings", icon: Settings, href: "settings" },
];

function getAllChildHrefs(item: NavItem): string[] {
	return item.children?.map((c) => c.href) ?? [];
}

function isChildActive(item: NavItem, currentPage: string): boolean {
	return getAllChildHrefs(item).includes(currentPage);
}

// --- Animation variants ---

const dropdownVariants = {
	hidden: { opacity: 0, scale: 0.95, y: -4 },
	visible: {
		opacity: 1,
		scale: 1,
		y: 0,
		transition: { duration: 0.12, ease: [0.32, 0.72, 0, 1] as const },
	},
	exit: {
		opacity: 0,
		scale: 0.95,
		y: -4,
		transition: { duration: 0.08, ease: [0.32, 0.72, 0, 1] as const },
	},
};

const upwardDropdownVariants = {
	hidden: { opacity: 0, scale: 0.95, y: 4 },
	visible: {
		opacity: 1,
		scale: 1,
		y: 0,
		transition: { duration: 0.12, ease: [0.32, 0.72, 0, 1] as const },
	},
	exit: {
		opacity: 0,
		scale: 0.95,
		y: 4,
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
	const hrefFor = (page: string) => buildHref?.(page) ?? `/app/${page}`;
	// --- Usage ---
	const { usage, loading: usageLoading } = useUsage();
	// --- Streak ---
	const { streak } = useStreak();
	const [isCancelling, setIsCancelling] = useState(false);
	const [billingStatusLoaded, setBillingStatusLoaded] = useState(false);
	const plan = usage?.plan || "free";
	const used = usage?.api_calls?.used || 0;
	const included = usage?.api_calls?.included || 200;
	const pct =
		included > 0 ? Math.min(Math.round((used / included) * 100), 100) : 0;

	// --- Collapsible nav ---
	const [expandedItems, setExpandedItems] = useState<Set<string>>(() => {
		const expanded = new Set<string>();
		for (const item of navItems) {
			if (item.children && isChildActive(item, currentPage)) {
				expanded.add(item.label);
			}
		}
		return expanded;
	});

	useEffect(() => {
		setExpandedItems((prev) => {
			const next = new Set(prev);
			for (const item of navItems) {
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

	// --- Org switcher ---
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
	const [orgMenuOpen, setOrgMenuOpen] = useState(false);
	const [createOrgOpen, setCreateOrgOpen] = useState(false);
	const [newOrgName, setNewOrgName] = useState("");
	const [newOrgSlug, setNewOrgSlug] = useState("");
	const [newOrgSlugEdited, setNewOrgSlugEdited] = useState(false);
	const [createOrgLoading, setCreateOrgLoading] = useState(false);
	const [createOrgError, setCreateOrgError] = useState<string | null>(null);

	const orgMenuRef = useRef<HTMLDivElement>(null);
	const userMenuRef = useRef<HTMLDivElement>(null);

	// Click-outside handler for org menu
	useEffect(() => {
		if (!orgMenuOpen) return;
		const handleClick = (e: MouseEvent) => {
			if (orgMenuRef.current && !orgMenuRef.current.contains(e.target as Node)) {
				setOrgMenuOpen(false);
				setOrgSearch("");
			}
		};
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [orgMenuOpen]);

	const loadOrganizations = useCallback(async () => {
		setOrgsLoading(true);
		try {
			const { organization: orgClient } = await loadAuthClient();
			const { data } = await orgClient.list();
			if (data) {
				const items: OrgListItem[] = data.map((o: any) => ({
					id: o.id,
					name: o.name,
					slug: o.slug,
					logo: o.logo,
				}));
				setOrgs(items);
				setCurrentOrg((prev) => {
					if (prev) {
						return items.find((o) => o.id === prev.id) ?? prev;
					}
					return items[0] ?? null;
				});
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

	const handleSwitchOrg = async (org: OrgListItem) => {
		setCurrentOrg(org);
		setOrgMenuOpen(false);
		setOrgSearch("");
		const { organization: orgClient } = await loadAuthClient();
		await orgClient.setActive({ organizationId: org.id });
		window.location.href = window.location.pathname;
	};

	const orgInitial = currentOrg?.name?.charAt(0)?.toUpperCase() || "?";
	const orgColor = currentOrg ? getOrgColor(currentOrg.id) : "bg-muted";

	// --- Notifications (via WebSocket) ---
	const [notifCount, setNotifCount] = useState(0);

	useEffect(() => {
		return scheduleIdleTask(() => {
			void fetchDashboardBootstrap().then((data) => {
				if (data?.notif_count != null) setNotifCount(data.notif_count);
			});
		}, 1500);
	}, []);

	// --- User menu ---
	const [userMenuOpen, setUserMenuOpen] = useState(false);

	useEffect(() => {
		if (plan === "pro" && userMenuOpen && !billingStatusLoaded) {
			fetch("/api/billing/status")
				.then((r) => (r.ok ? r.json() : null))
				.then((data) => {
					setIsCancelling(!!data?.subscription?.cancelAtPeriodEnd);
				})
				.catch(() => {})
				.finally(() => {
					setBillingStatusLoaded(true);
				});
		}
	}, [plan, userMenuOpen, billingStatusLoaded]);

	// Click-outside handler for user menu
	useEffect(() => {
		if (!userMenuOpen) return;
		const handleClick = (e: MouseEvent) => {
			if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
				setUserMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [userMenuOpen]);

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
		return (
			<a
				key={item.href}
				href={hrefFor(item.href)}
				onClick={() => onClose()}
				onMouseEnter={() => onPrefetch?.(item.href)}
				onFocus={() => onPrefetch?.(item.href)}
				className={cn(
					"flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors",
					isActive
						? "bg-accent/80 text-foreground font-medium"
						: "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
				)}
			>
				<item.icon className="size-4 shrink-0" />
				<span className="flex-1 text-left">{item.label}</span>
			</a>
		);
	};

	const renderCollapsibleItem = (item: NavItem) => {
		const isExpanded = expandedItems.has(item.label);
		const hasActiveChild = isChildActive(item, currentPage);

		return (
			<div key={item.label}>
				<button
					onClick={() => toggleExpand(item)}
					onMouseEnter={() => prefetchItem(item)}
					onFocus={() => prefetchItem(item)}
					className={cn(
						"flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors",
						hasActiveChild
							? "text-foreground font-medium"
							: "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
					)}
				>
					<item.icon className="size-4 shrink-0" />
					<span className="flex-1 text-left">{item.label}</span>
					<motion.div
						animate={{ rotate: isExpanded ? 90 : 0 }}
						transition={{
							duration: 0.15,
							ease: [0.32, 0.72, 0, 1],
						}}
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
							transition={{
								duration: 0.15,
								ease: [0.32, 0.72, 0, 1],
							}}
							className="overflow-hidden"
						>
							<div className="ml-4 border-l border-border pl-2 mt-0.5 space-y-px">
								{item.children.map((child) => {
									const isActive = currentPage === child.href;
									return (
										<a
											key={child.href}
											href={hrefFor(child.href)}
											onClick={() => onClose()}
											onMouseEnter={() => onPrefetch?.(child.href)}
											onFocus={() => onPrefetch?.(child.href)}
											className={cn(
												"flex w-full items-center gap-2 rounded-md px-2 py-1 text-[12.5px] transition-colors",
												isActive
													? "text-foreground font-medium bg-accent/60"
													: "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
											)}
										>
											<span>{child.label}</span>
											{child.badge && (
												<span className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider bg-primary/10 text-primary">
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

	const renderNavItem = (item: NavItem) => {
		if (item.children) return renderCollapsibleItem(item);
		return renderFlatItem(item);
	};

	return (
		<>
			{isOpen && (
				<div
					className="fixed inset-0 z-40 bg-black/50 md:hidden"
					onClick={onClose}
				/>
			)}

			<aside
				className={cn(
					"fixed top-0 left-0 z-60 h-dvh w-56 shrink-0 border-r border-border bg-sidebar transition-transform duration-200 md:static md:z-auto md:h-auto md:translate-x-0",
					isOpen ? "translate-x-0" : "-translate-x-full",
				)}
			>
				<div className="flex flex-col h-full">
					{/* Header: Org switcher + mobile close */}
					<div className="shrink-0 px-3 pt-3 pb-2">
						<div className="flex items-center justify-between">
							<div ref={orgMenuRef} className="relative flex-1 min-w-0">
								<button
									onClick={() => {
										const nextOpen = !orgMenuOpen;
										setOrgMenuOpen(nextOpen);
										if (
											nextOpen &&
											(!orgsLoaded || orgs.length === 0) &&
											!orgsLoading
										) {
											void loadOrganizations();
										}
									}}
									className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40 transition-colors"
								>
									{currentOrg?.logo ? (
										<img
											src={currentOrg.logo}
											alt={currentOrg.name}
											className="size-6 rounded object-cover shrink-0"
										/>
									) : (
										<div
											className={cn(
												"flex size-6 items-center justify-center rounded text-[11px] font-bold text-white shrink-0",
												orgColor,
											)}
										>
											{orgInitial}
										</div>
									)}
									<span className="text-[13px] font-medium truncate flex-1 text-left">
										{currentOrg?.name || "Select org"}
									</span>
									<ChevronsUpDown className="size-3 text-muted-foreground shrink-0" />
								</button>

								<AnimatePresence>
									{orgMenuOpen && (
										<motion.div
												variants={dropdownVariants}
												initial="hidden"
												animate="visible"
												exit="exit"
												className="absolute left-0 top-full z-[60] mt-1 w-52 rounded-md border border-border bg-background p-1 shadow-lg origin-top-left"
											>
												{orgsLoading ? (
													<div className="flex items-center justify-center py-3">
														<Loader2 className="size-4 animate-spin text-muted-foreground" />
													</div>
												) : (
													<>
														{orgs.length > 5 && (
															<div className="px-1 pb-1">
																<input
																	type="text"
																	placeholder="Search organizations..."
																	value={orgSearch}
																	onChange={(e) => setOrgSearch(e.target.value)}
																	className="w-full rounded border border-border bg-background px-2 py-1 text-[12px] outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
																	autoFocus
																/>
															</div>
														)}
														<div className="max-h-[200px] overflow-y-auto">
															{orgs
																.filter((org) =>
																	!orgSearch || org.name.toLowerCase().includes(orgSearch.toLowerCase())
																)
																.map((org) => (
																	<button
																		key={org.id}
																		onClick={() => handleSwitchOrg(org)}
																		className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-[13px] hover:bg-accent/40 transition-colors"
																	>
																		{org.logo ? (
																			<img
																				src={org.logo}
																				alt={org.name}
																				className="size-5 rounded object-cover shrink-0"
																			/>
																		) : (
																			<div
																				className={cn(
																					"flex size-5 items-center justify-center rounded text-[10px] font-bold text-white shrink-0",
																					getOrgColor(org.id),
																				)}
																			>
																				{org.name.charAt(0).toUpperCase()}
																			</div>
																		)}
																		<span className="truncate flex-1 text-left">
																			{org.name}
																		</span>
																		{org.id === currentOrg?.id && (
																			<Check className="size-3.5 text-foreground shrink-0" />
																		)}
																	</button>
																))}
														</div>
													</>
												)}
												<div className="my-1 border-t border-border" />
												<button
													onClick={() => {
														setOrgMenuOpen(false);
														setCreateOrgOpen(true);
													}}
													className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
												>
													<Plus className="size-3.5 shrink-0" />
													<span>Create organization</span>
												</button>
											</motion.div>
									)}
								</AnimatePresence>
							</div>

							<button
								className="rounded p-1 hover:bg-accent/50 md:hidden ml-1"
								onClick={onClose}
							>
								<X className="size-3.5" />
							</button>
						</div>
					</div>

					{/* Navigation */}
					<ScrollArea className="flex-1 min-h-0">
						<nav className="space-y-px px-3 py-2">
							{navItems.map(renderNavItem)}
						</nav>
					</ScrollArea>

					{/* Footer: Notifications + User */}
					<div className="shrink-0 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] space-y-1">
						{/* Streak badge */}
						{streak?.active && streak.current_streak_days > 0 && (
							<div
								className="group relative flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px]"
								title={`${streak.current_streak_days}-day posting streak! Best: ${streak.best_streak_days} days. ${streak.hours_remaining != null ? `${Math.round(streak.hours_remaining)}h remaining` : ""}`}
							>
								<Flame
									className={cn(
										"size-4 shrink-0",
										streak.hours_remaining != null && streak.hours_remaining < 2
											? "text-red-400 animate-pulse"
											: "text-amber-400",
									)}
								/>
								<span
									className={cn(
										"font-semibold",
										streak.hours_remaining != null && streak.hours_remaining < 2
											? "text-red-400"
											: "text-amber-400",
									)}
								>
									{streak.current_streak_days}d streak
								</span>
								{streak.hours_remaining != null && streak.hours_remaining < 2 && (
									<span className="text-[10px] text-red-400/70 ml-auto">
										{Math.round(streak.hours_remaining * 60)}m left
									</span>
								)}
							</div>
						)}

						{/* Notification button */}
						<button
							onClick={() => onNavigate("notifications")}
							className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
						>
							<Bell className="size-4 shrink-0" />
							<span className="flex-1 text-left">Notifications</span>
							{notifCount > 0 && (
								<span className="flex size-5 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold text-white">
									{notifCount > 99 ? "99+" : notifCount}
								</span>
							)}
						</button>

						{/* User block */}
						<div ref={userMenuRef} className="relative">
							<button
								onClick={() => setUserMenuOpen(!userMenuOpen)}
								className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/40 transition-colors"
							>
								{user?.image ? (
									<img
										src={user.image}
										alt={user.name}
										className="size-6 rounded-full object-cover shrink-0"
									/>
								) : (
									<div className="flex size-6 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground shrink-0">
										{userInitials}
									</div>
								)}
								<span className="text-[13px] font-medium truncate flex-1 text-left">
									{user?.name || "User"}
								</span>
							</button>

							<AnimatePresence>
								{userMenuOpen && (
										<motion.div
											variants={upwardDropdownVariants}
											initial="hidden"
											animate="visible"
											exit="exit"
											className="absolute left-0 bottom-full z-[60] mb-1.5 w-52 rounded-md border border-border bg-background p-1 shadow-lg origin-bottom-left"
										>
											{/* User info */}
											<div className="px-2 py-2">
												<p className="text-[13px] font-medium">
													{user?.name || "User"}
												</p>
												<p className="text-[11px] text-muted-foreground">
													{user?.email || ""}
												</p>
											</div>

											{/* Org plan info */}
											{!usageLoading && (
												<>
													<div className="my-1 border-t border-border" />
													<button
														onClick={() => {
															onNavigate("settings");
															setUserMenuOpen(false);
														}}
														className="w-full px-2 py-1.5 rounded hover:bg-accent/40 transition-colors text-left"
													>
														<div className="flex items-center gap-1.5">
															{currentOrg?.logo ? (
																<img
																	src={currentOrg.logo}
																	alt={currentOrg.name}
																	className="size-4 rounded object-cover shrink-0"
																/>
															) : (
																<div
																	className={cn(
																		"flex size-4 items-center justify-center rounded text-[8px] font-bold text-white shrink-0",
																		orgColor,
																	)}
																>
																	{orgInitial}
																</div>
															)}
															<span className="text-[11px] font-medium text-foreground truncate">
																{currentOrg?.name || "Org"}
															</span>
															<span
																className={cn(
																	"rounded px-1 py-px text-[8px] font-semibold uppercase tracking-wider shrink-0 ml-auto",
																	plan === "pro"
																		? isCancelling
																			? "bg-amber-500/10 text-amber-500"
																			: "bg-primary/10 text-primary"
																		: "bg-muted text-muted-foreground",
																)}
															>
																{plan === "pro"
																	? isCancelling
																		? "Ending"
																		: "Pro"
																	: "Free"}
															</span>
														</div>
														<div className="flex items-center justify-between mt-1.5">
															<div className="flex-1 h-1 rounded-full bg-accent/50">
																<div
																	className={cn(
																		"h-1 rounded-full transition-all",
																		pct > 95
																			? "bg-red-400"
																			: pct > 80
																				? "bg-amber-400"
																				: "bg-primary/70",
																	)}
																	style={{ width: `${pct}%` }}
																/>
															</div>
															<span className="text-[10px] text-muted-foreground ml-2 shrink-0">
																{formatNumber(used)}/{formatNumber(included)}
															</span>
														</div>
													</button>
													{plan !== "pro" && (
														<div className="px-2 pb-1">
															<button
																onClick={() => {
																	onNavigate("billing");
																	setUserMenuOpen(false);
																}}
																className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary/10 py-1 text-[11px] font-medium text-primary hover:bg-primary/15 transition-colors"
															>
																<Sparkles className="size-3" />
																Upgrade to Pro
															</button>
														</div>
													)}
												</>
											)}

											<div className="my-1 border-t border-border" />

											{/* Links */}
											<a
												href="https://docs.relayapi.dev/"
												target="_blank"
												rel="noopener noreferrer"
												className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
											>
												<BookOpen className="size-3.5 shrink-0" />
												Documentation
											</a>
											<button
												onClick={() => {
													onNavigate("profile");
													setUserMenuOpen(false);
												}}
												className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
											>
												<User className="size-3.5 shrink-0" />
												Profile
											</button>
											<button
												onClick={() => {
													const prevParams = new URLSearchParams(window.location.search);
													const nextParams = new URLSearchParams();
													for (const key of ["workspace", "account"]) {
														const value = prevParams.get(key);
														if (value) nextParams.set(key, value);
													}
													nextParams.set("tab", "notifications");
													window.location.assign(`/app/settings?${nextParams}`);
													setUserMenuOpen(false);
												}}
												className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
											>
												<BellDot className="size-3.5 shrink-0" />
												Notification preferences
											</button>
											{user?.role === "admin" && (
												<button
													onClick={() => {
														onNavigate("admin-users");
														setUserMenuOpen(false);
													}}
													className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
												>
													<Shield className="size-3.5 shrink-0" />
													Admin
												</button>
											)}

											<div className="my-1 border-t border-border" />
											<button
												onClick={handleSignOut}
												className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
											>
												<LogOut className="size-3.5 shrink-0" />
												Sign out
											</button>
										</motion.div>
								)}
							</AnimatePresence>
						</div>
					</div>
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
							<div className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive">
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
								className="w-full rounded-lg border border-border bg-background py-2.5 px-3 text-sm text-foreground placeholder:text-muted-foreground/50 transition-colors focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/25"
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
								className="w-full rounded-lg border border-border bg-background py-2.5 px-3 text-sm text-foreground placeholder:text-muted-foreground/50 transition-colors focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/25 font-mono"
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
