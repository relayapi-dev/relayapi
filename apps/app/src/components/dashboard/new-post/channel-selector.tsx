import { ChevronRight, FolderOpen, Loader2, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
	platformAvatars,
	platformColors,
	platformLabels,
} from "@/lib/platform-maps";

interface Account {
	id: string;
	platform: string;
	platform_account_id: string;
	username: string | null;
	display_name: string | null;
	avatar_url: string | null;
	metadata: Record<string, unknown> | null;
	connected_at: string;
	updated_at: string;
}

interface Workspace {
	id: string;
	name: string;
	description: string | null;
	account_ids: string[];
	created_at: string;
}

interface ChannelSelectorProps {
	accounts: Account[];
	workspaces: Workspace[];
	selectedAccountIds: string[];
	selectedGroupIds: string[];
	onToggleAccount: (id: string, checked: boolean) => void;
	onToggleGroup: (id: string, checked: boolean) => void;
	onDeselectAll: () => void;
	loading: boolean;
	search: string;
	onSearchChange: (value: string) => void;
	accountsHasMore: boolean;
	accountsLoadMore: () => void;
	accountsLoadingMore: boolean;
	workspacesHasMore: boolean;
	workspacesLoadMore: () => void;
	workspacesLoadingMore: boolean;
}

function AccountRow({
	account,
	checked,
	onToggle,
	indented,
	isLast,
}: {
	account: Account;
	checked: boolean;
	onToggle: (id: string, checked: boolean) => void;
	indented?: boolean;
	isLast?: boolean;
}) {
	return (
		<label
			className={cn(
				"flex items-center gap-3 py-2 hover:bg-accent/30 cursor-pointer transition-colors",
				indented ? "pl-9 pr-3" : "px-3",
				!isLast && "border-b border-border",
			)}
		>
			<Checkbox
				checked={checked}
				onCheckedChange={(c) => onToggle(account.id, !!c)}
			/>
			{account.avatar_url ? (
				<div className="relative shrink-0">
					<img
						src={account.avatar_url}
						alt=""
						className="size-7 rounded-full object-cover"
					/>
					<div
						className={cn(
							"absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full text-[5px] font-bold text-white ring-2 ring-background",
							platformColors[account.platform] || "bg-neutral-700",
						)}
					>
						{platformAvatars[account.platform] ||
							account.platform.slice(0, 2).toUpperCase()}
					</div>
				</div>
			) : (
				<div
					className={cn(
						"flex size-7 items-center justify-center rounded-full text-[9px] font-bold text-white shrink-0",
						platformColors[account.platform] || "bg-neutral-700",
					)}
				>
					{platformAvatars[account.platform] ||
						account.platform.slice(0, 2).toUpperCase()}
				</div>
			)}
			<div className="flex-1 min-w-0">
				<p className="text-[13px] font-medium truncate">
					{account.display_name ||
						account.username ||
						account.platform_account_id}
				</p>
				<p className="text-[11px] text-muted-foreground">
					{platformLabels[account.platform] || account.platform}
				</p>
			</div>
		</label>
	);
}

export function ChannelSelector({
	accounts,
	workspaces,
	selectedAccountIds,
	selectedGroupIds,
	onToggleAccount,
	onToggleGroup,
	onDeselectAll,
	loading,
	search,
	onSearchChange,
	accountsHasMore,
	accountsLoadMore,
	accountsLoadingMore,
	workspacesHasMore,
	workspacesLoadMore,
	workspacesLoadingMore,
}: ChannelSelectorProps) {
	const sentinelRef = useRef<HTMLDivElement>(null);
	const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());

	useEffect(() => {
		const el = sentinelRef.current;
		if (!el) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) {
					if (accountsHasMore && !accountsLoadingMore) accountsLoadMore();
					if (workspacesHasMore && !workspacesLoadingMore) workspacesLoadMore();
				}
			},
			{ threshold: 0.1 },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [accountsHasMore, accountsLoadMore, accountsLoadingMore, workspacesHasMore, workspacesLoadMore, workspacesLoadingMore]);

	const totalSelected = selectedAccountIds.length;

	// Build account lookup
	const accountById = useMemo(() => {
		const map = new Map<string, Account>();
		for (const a of accounts) map.set(a.id, a);
		return map;
	}, [accounts]);

	// Find accounts that belong to a workspace (only those we have loaded)
	const workspaceAccounts = useMemo(() => {
		const map = new Map<string, Account[]>();
		for (const ws of workspaces) {
			const members: Account[] = [];
			for (const aid of ws.account_ids ?? []) {
				const acc = accountById.get(aid);
				if (acc) members.push(acc);
			}
			map.set(ws.id, members);
		}
		return map;
	}, [workspaces, accountById]);

	// Find ungrouped accounts (not in any workspace)
	const groupedAccountIds = useMemo(() => {
		const ids = new Set<string>();
		for (const ws of workspaces) {
			for (const aid of ws.account_ids ?? []) ids.add(aid);
		}
		return ids;
	}, [workspaces]);

	const ungroupedAccounts = useMemo(
		() => accounts.filter((a) => !groupedAccountIds.has(a.id)),
		[accounts, groupedAccountIds],
	);

	// Workspace checkbox state
	const getWorkspaceCheckState = (ws: Workspace): boolean | "indeterminate" => {
		const members = workspaceAccounts.get(ws.id) ?? [];
		if (members.length === 0) return false;
		const selectedCount = members.filter((a) => selectedAccountIds.includes(a.id)).length;
		if (selectedCount === 0) return false;
		if (selectedCount === members.length) return true;
		return "indeterminate";
	};

	const toggleExpand = (wsId: string) => {
		setExpandedWorkspaces((prev) => {
			const next = new Set(prev);
			if (next.has(wsId)) next.delete(wsId);
			else next.add(wsId);
			return next;
		});
	};

	// Selected channel pills
	const selectedAccounts = accounts.filter((a) =>
		selectedAccountIds.includes(a.id),
	);

	const hasContent = workspaces.length > 0 || accounts.length > 0;

	return (
		<div className="flex flex-col py-3">
			{/* Selected pills row */}
			{selectedAccounts.length > 0 && (
				<div className="flex items-center gap-1.5 px-5 pb-3 flex-wrap">
					{selectedAccounts.map((account) => (
						<button
							key={account.id}
							type="button"
							onClick={() => onToggleAccount(account.id, false)}
							className="group inline-flex items-center gap-1.5 rounded-full border border-border bg-accent/20 pl-1 pr-2 py-0.5 text-[11px] hover:bg-accent/40 transition-colors"
						>
							{account.avatar_url ? (
								<img
									src={account.avatar_url}
									alt=""
									className="size-4 rounded-full object-cover"
								/>
							) : (
								<div
									className={cn(
										"flex size-4 items-center justify-center rounded-full text-[7px] font-bold text-white shrink-0",
										platformColors[account.platform] || "bg-neutral-700",
									)}
								>
									{platformAvatars[account.platform] ||
										account.platform.slice(0, 2).toUpperCase()}
								</div>
							)}
							<span className="truncate max-w-24">
								{account.display_name || account.username || account.platform_account_id}
							</span>
							<X className="size-3 text-muted-foreground group-hover:text-foreground shrink-0" />
						</button>
					))}
				</div>
			)}

			{/* Search */}
			<div className="px-5 pb-3">
				<div className="relative">
					<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
					<input
						type="text"
						value={search}
						onChange={(e) => onSearchChange(e.target.value)}
						placeholder="Search channels..."
						className="w-full rounded-lg border border-border bg-background pl-9 pr-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
					/>
					{search && (
						<button
							type="button"
							onClick={() => onSearchChange("")}
							className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 hover:bg-accent/50"
						>
							<X className="size-3 text-muted-foreground" />
						</button>
					)}
				</div>
			</div>

			{/* Header */}
			<div className="flex items-center justify-between px-5 pb-2">
				<span className="text-xs font-medium text-muted-foreground">
					Channels
				</span>
				{totalSelected > 0 && (
					<button
						type="button"
						onClick={onDeselectAll}
						className="text-[11px] text-primary hover:underline"
					>
						Deselect all
					</button>
				)}
			</div>

			{/* Tree list */}
			<div className="flex-1 min-h-0 overflow-y-auto px-5 pb-2">
				<div className="rounded-lg border border-border overflow-hidden">
					{loading ? (
						<div className="flex items-center justify-center py-10">
							<Loader2 className="size-5 animate-spin text-muted-foreground" />
						</div>
					) : !hasContent ? (
						<div className="p-6 text-center">
							<p className="text-sm text-muted-foreground">
								{search ? "No results found" : "No connected accounts"}
							</p>
							{!search && (
								<p className="text-xs text-muted-foreground mt-1">
									Connect accounts in the Connections page first.
								</p>
							)}
						</div>
					) : (
						<>
							{/* Workspace tree nodes */}
							{workspaces.map((ws) => {
								const members = workspaceAccounts.get(ws.id) ?? [];
								const isExpanded = expandedWorkspaces.has(ws.id);
								const checkState = getWorkspaceCheckState(ws);
								const hasUngroupedBelow = ungroupedAccounts.length > 0 || workspacesHasMore || accountsHasMore;

								return (
									<div key={ws.id} className={cn(!isExpanded && (hasUngroupedBelow || ws !== workspaces[workspaces.length - 1]) && "border-b border-border")}>
										{/* Workspace row */}
										<div className="flex items-center gap-2 px-3 py-2.5 hover:bg-accent/30 transition-colors">
											<Checkbox
												checked={checkState}
												onCheckedChange={(checked) =>
													onToggleGroup(ws.id, !!checked)
												}
											/>
											<button
												type="button"
												onClick={() => toggleExpand(ws.id)}
												className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
											>
												<ChevronRight
													className={cn(
														"size-3.5 text-muted-foreground transition-transform shrink-0",
														isExpanded && "rotate-90",
													)}
												/>
												<FolderOpen className="size-4 text-muted-foreground shrink-0" />
												<span className="text-[13px] font-medium truncate">
													{ws.name}
												</span>
												<span className="text-[11px] text-muted-foreground shrink-0">
													{members.length}/{ws.account_ids?.length ?? 0}
												</span>
											</button>
										</div>

										{/* Expanded children */}
										{isExpanded && (
											<div className={cn(hasUngroupedBelow || ws !== workspaces[workspaces.length - 1] ? "border-b border-border" : "")}>
												{members.length > 0 ? (
													members.map((account, i) => (
														<AccountRow
															key={account.id}
															account={account}
															checked={selectedAccountIds.includes(account.id)}
															onToggle={onToggleAccount}
															indented
															isLast={i === members.length - 1}
														/>
													))
												) : (
													<p className="pl-9 pr-3 py-2.5 text-[11px] text-muted-foreground border-b border-border">
														No accounts loaded for this workspace
													</p>
												)}
											</div>
										)}
									</div>
								);
							})}

							{/* Load more workspaces */}
							{workspacesLoadingMore && (
								<div className="flex items-center justify-center py-2 border-b border-border">
									<Loader2 className="size-4 animate-spin text-muted-foreground" />
								</div>
							)}
							{workspacesHasMore && !workspacesLoadingMore && (
								<button
									type="button"
									onClick={workspacesLoadMore}
									className="w-full py-2 text-[11px] text-primary hover:bg-accent/20 transition-colors border-b border-border"
								>
									Load more workspaces
								</button>
							)}

							{/* Ungrouped accounts */}
							{ungroupedAccounts.length > 0 && (
								<>
									{workspaces.length > 0 && (
										<div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold bg-accent/20 border-b border-border">
											Ungrouped
										</div>
									)}
									{ungroupedAccounts.map((account, i) => (
										<AccountRow
											key={account.id}
											account={account}
											checked={selectedAccountIds.includes(account.id)}
											onToggle={onToggleAccount}
											isLast={i === ungroupedAccounts.length - 1 && !accountsHasMore}
										/>
									))}
								</>
							)}

							{/* Load more accounts */}
							{accountsLoadingMore && (
								<div className="flex items-center justify-center py-2">
									<Loader2 className="size-4 animate-spin text-muted-foreground" />
								</div>
							)}
							{accountsHasMore && !accountsLoadingMore && (
								<button
									type="button"
									onClick={accountsLoadMore}
									className="w-full py-2 text-[11px] text-primary hover:bg-accent/20 transition-colors"
								>
									Load more accounts
								</button>
							)}

							{/* Sentinel for infinite scroll */}
							<div ref={sentinelRef} className="h-1" />
						</>
					)}
				</div>
			</div>

			{totalSelected > 0 && (
				<div className="px-5 pt-1 pb-1">
					<p className="text-[11px] text-muted-foreground">
						{totalSelected} account{totalSelected !== 1 ? "s" : ""} selected
					</p>
				</div>
			)}
		</div>
	);
}
