import { Clock, FileEdit, FileText, Link2, Loader2, Plus, Search, Send } from "lucide-react";
import { CrossPostActionsPanel, CrossPostActionsTrigger, type CrossPostAction } from "./cross-post-actions-section";
import * as Popover from "@radix-ui/react-popover";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { usePaginatedApi } from "@/hooks/use-api";
import {
	countCharsForPlatform,
	PLATFORM_CHAR_LIMITS,
} from "@/lib/platform-char-limits";
import {
	platformAvatars,
	platformColors,
	platformLabels,
} from "@/lib/platform-maps";
import { cn } from "@/lib/utils";
import { ChannelSelector } from "./new-post/channel-selector";
import { ChannelEditor } from "./new-post/channel-editor";

// ── Types ──

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

export interface EditPostData {
	id: string;
	content: string | null;
	status: string;
	scheduled_at: string | null;
	timezone: string | null;
	media: Array<{ url: string; type?: string }> | null;
	targets: Record<string, { platform: string; accounts?: Array<{ id: string }> }>;
	target_options: Record<string, Record<string, any>> | null;
}

interface ConvertFromIdea {
	id: string;
	content: string | null;
	media: Array<{ url: string; type?: string }>;
}

interface NewPostDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: (post?: any) => void;
	initialDate?: string;
	initialPublishMode?: PublishMode;
	editPostId?: string | null;
	editPostData?: EditPostData | null;
	convertFromIdea?: ConvertFromIdea | null;
}

type PublishMode = "now" | "draft" | "schedule";

function inferMediaType(
	url: string,
): "image" | "video" | "gif" | "document" | undefined {
	const ext = url.split("?")[0]?.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;
	if (["jpg", "jpeg", "png", "webp", "avif", "svg"].includes(ext))
		return "image";
	if (["mp4", "mov", "avi", "webm", "mkv"].includes(ext)) return "video";
	if (ext === "gif") return "gif";
	if (["pdf", "doc", "docx"].includes(ext)) return "document";
	return undefined;
}

// ── Main component ──

export function NewPostDialog({
	open,
	onOpenChange,
	onCreated,
	initialDate,
	initialPublishMode,
	editPostId,
	editPostData,
	convertFromIdea,
}: NewPostDialogProps) {
	// Selection
	const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
	const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
	const [channelPickerOpen, setChannelPickerOpen] = useState(false);
	const [channelSearch, setChannelSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const handleSearchChange = useCallback((value: string) => {
		setChannelSearch(value);
		if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
		searchTimerRef.current = setTimeout(() => setDebouncedSearch(value), 300);
	}, []);

	// Shared content model
	const [sharedContent, setSharedContent] = useState("");
	const [sharedMedia, setSharedMedia] = useState<
		Array<{ url: string; type?: string; previewUrl?: string }>
	>([]);
	const [channelOverrides, setChannelOverrides] = useState<
		Record<
			string,
			{
				content?: string;
				media?: Array<{ url: string; type?: string; previewUrl?: string }>;
			}
		>
	>({});
	const [unlinkedFields, setUnlinkedFields] = useState<
		Record<string, Set<string>>
	>({});

	// Platform options
	const [targetOptions, setTargetOptions] = useState<
		Record<string, Record<string, any>>
	>({});

	// Active tab
	const [activeTabId, setActiveTabId] = useState<string | null>(null);

	// Publish settings
	const [publishMode, setPublishMode] = useState<PublishMode>("now");
	const [scheduledDate, setScheduledDate] = useState("");
	const [timezone, setTimezone] = useState(
		() => Intl.DateTimeFormat().resolvedOptions().timeZone,
	);

	// Cross-post actions
	const [crossPostActions, setCrossPostActions] = useState<CrossPostAction[]>([]);
	const [crossPostExpanded, setCrossPostExpanded] = useState(false);

	// Short links
	const [shortenUrls, setShortenUrls] = useState(false);
	const [slModeConfig, setSlModeConfig] = useState<"always" | "ask" | "never">("never");

	// Template picker
	const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
	const [templateSearch, setTemplateSearch] = useState("");
	const [templates, setTemplates] = useState<Array<{ id: string; name: string; content: string; tags: string[] | null }>>([]);
	const [templatesLoading, setTemplatesLoading] = useState(false);

	// Fetch templates when picker opens
	useEffect(() => {
		if (templatePickerOpen && templates.length === 0) {
			setTemplatesLoading(true);
			fetch("/api/content-templates?limit=100")
				.then((r) => r.ok ? r.json() : { data: [] })
				.then((res) => setTemplates(res.data || []))
				.catch(() => {})
				.finally(() => setTemplatesLoading(false));
		}
	}, [templatePickerOpen]);

	const filteredTemplates = templateSearch
		? templates.filter(
				(t) =>
					t.name.toLowerCase().includes(templateSearch.toLowerCase()) ||
					t.content.toLowerCase().includes(templateSearch.toLowerCase()),
			)
		: templates;

	const applyTemplate = (tmpl: { content: string }) => {
		if (sharedContent && sharedContent.trim()) {
			if (!confirm("Replace current content with template?")) return;
		}
		setSharedContent(tmpl.content);
		setTemplatePickerOpen(false);
		setTemplateSearch("");
	};

	// UI
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [uploading, setUploading] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Fetch short link config when dialog opens
	useEffect(() => {
		if (open) {
			fetch("/api/short-links/config")
				.then((r) => r.ok ? r.json() : null)
				.then((data) => {
					if (data?.mode) setSlModeConfig(data.mode);
				})
				.catch(() => {});
		}
	}, [open]);

	// Pre-fill state when dialog opens
	useEffect(() => {
		if (open && editPostData) {
			// Edit mode: pre-fill from existing post data
			setSharedContent(editPostData.content ?? "");

			if (editPostData.media?.length) {
				setSharedMedia(editPostData.media.map((m) => ({ url: m.url, type: m.type })));
			}

			// Extract account IDs from targets
			const accountIds: string[] = [];
			for (const target of Object.values(editPostData.targets)) {
				if (target.accounts) {
					for (const acc of target.accounts) {
						accountIds.push(acc.id);
					}
				}
			}
			setSelectedAccountIds(accountIds);

			// Restore target_options, channel overrides, and unlinked fields
			if (editPostData.target_options) {
				const platformOpts: Record<string, Record<string, any>> = {};
				const overrides: Record<string, { content?: string; media?: Array<{ url: string; type?: string; previewUrl?: string }> }> = {};
				const unlinked: Record<string, Set<string>> = {};

				for (const [key, opts] of Object.entries(editPostData.target_options)) {
					if (key.startsWith("acc_")) {
						// Per-account overrides
						const { content, media, ...rest } = opts;
						if (content !== undefined) {
							overrides[key] = { ...overrides[key], content };
							unlinked[key] = unlinked[key] ?? new Set();
							unlinked[key].add("content");
						}
						if (media !== undefined) {
							overrides[key] = { ...overrides[key], media };
							unlinked[key] = unlinked[key] ?? new Set();
							unlinked[key].add("media");
						}
						if (Object.keys(rest).length > 0) {
							platformOpts[key] = rest;
						}
					} else {
						platformOpts[key] = opts;
					}
				}
				setTargetOptions(platformOpts);
				setChannelOverrides(overrides);
				setUnlinkedFields(unlinked);
			}

			// Pre-fill publish mode and schedule
			if (editPostData.status === "draft") {
				setPublishMode("draft");
			} else if (editPostData.scheduled_at && editPostData.scheduled_at !== "now" && editPostData.scheduled_at !== "draft") {
				setPublishMode("schedule");
				const dt = new Date(editPostData.scheduled_at);
				const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000)
					.toISOString()
					.slice(0, 16);
				setScheduledDate(local);
			} else {
				setPublishMode("now");
			}

			if (editPostData.timezone) {
				setTimezone(editPostData.timezone);
			}
		} else if (open && convertFromIdea) {
			// Convert-from-idea mode: pre-fill content + media, user picks channels
			setSharedContent(convertFromIdea.content ?? "");
			if (convertFromIdea.media.length > 0) {
				setSharedMedia(
					convertFromIdea.media.map((m) => ({
						url: m.url,
						...(m.type ? { type: m.type } : {}),
					})),
				);
			}
			setPublishMode("draft");
		} else if (open) {
			// Create mode
			if (initialDate) {
				const candidate = initialDate.includes("T") ? initialDate : `${initialDate}T09:00`;
				const candidateDate = new Date(candidate);
				const maxScheduleDate = new Date();
				maxScheduleDate.setDate(maxScheduleDate.getDate() + 30);
				if (candidateDate <= new Date() || candidateDate > maxScheduleDate) {
					setPublishMode("now");
				} else {
					setPublishMode("schedule");
					setScheduledDate(candidate);
				}
			} else if (initialPublishMode) {
				setPublishMode(initialPublishMode);
			} else {
				setPublishMode("now");
			}
		}
	}, [open, initialDate, initialPublishMode, editPostData, convertFromIdea]);

	// Data fetching — server-side search, paginated
	const searchQuery = useMemo(() => {
		const q: Record<string, string | undefined> = {};
		if (debouncedSearch.trim()) q.search = debouncedSearch.trim();
		return q;
	}, [debouncedSearch]);
	const {
		data: accounts,
		loading: accountsLoading,
		hasMore: accountsHasMore,
		loadMore: accountsLoadMore,
		loadingMore: accountsLoadingMore,
	} = usePaginatedApi<Account>(open ? "accounts" : null, { limit: 30, query: searchQuery });
	const {
		data: groups,
		loading: groupsLoading,
		hasMore: groupsHasMore,
		loadMore: groupsLoadMore,
		loadingMore: groupsLoadingMore,
	} = usePaginatedApi<Workspace>(open ? "workspaces" : null, { limit: 30, query: searchQuery });

	// Resolved selected accounts (expanding workspaces)
	const resolvedAccounts = useMemo(() => {
		const ids = new Set(selectedAccountIds);
		for (const group of groups) {
			if (selectedGroupIds.includes(group.id)) {
				for (const aid of group.account_ids) ids.add(aid);
			}
		}
		return accounts.filter((a) => ids.has(a.id));
	}, [accounts, groups, selectedAccountIds, selectedGroupIds]);

	// Active platforms
	const activePlatforms = useMemo(
		() => new Set(resolvedAccounts.map((a) => a.platform)),
		[resolvedAccounts],
	);

	// Auto-select first tab when accounts change
	useEffect(() => {
		if (resolvedAccounts.length > 0) {
			// If current tab is no longer in the list, switch to first
			if (!activeTabId || !resolvedAccounts.find((a) => a.id === activeTabId)) {
				setActiveTabId(resolvedAccounts[0]?.id ?? null);
			}
		} else {
			setActiveTabId(null);
		}
	}, [resolvedAccounts, activeTabId]);

	// Option helpers
	const setOption = useCallback(
		(platform: string, key: string, value: unknown) => {
			setTargetOptions((prev) => ({
				...prev,
				[platform]: { ...prev[platform], [key]: value },
			}));
		},
		[],
	);

	const getOption = useCallback(
		(platform: string, key: string, fallback: any = "") => {
			return targetOptions[platform]?.[key] ?? fallback;
		},
		[targetOptions],
	);

	// Content change handler
	const handleContentChange = useCallback(
		(accountId: string, value: string) => {
			const isUnlinked = unlinkedFields[accountId]?.has("content");
			if (isUnlinked) {
				setChannelOverrides((prev) => ({
					...prev,
					[accountId]: { ...prev[accountId], content: value },
				}));
			} else {
				setSharedContent(value);
			}
		},
		[unlinkedFields],
	);

	// Unlink / relink
	const handleUnlinkField = useCallback(
		(accountId: string, field: "content" | "media") => {
			setUnlinkedFields((prev) => {
				const current = new Set(prev[accountId] || []);
				current.add(field);
				return { ...prev, [accountId]: current };
			});
			if (field === "content") {
				setChannelOverrides((prev) => ({
					...prev,
					[accountId]: { ...prev[accountId], content: sharedContent },
				}));
			} else {
				setChannelOverrides((prev) => ({
					...prev,
					[accountId]: { ...prev[accountId], media: [...sharedMedia] },
				}));
			}
		},
		[sharedContent, sharedMedia],
	);

	const handleRelinkField = useCallback(
		(accountId: string, field: "content" | "media") => {
			setUnlinkedFields((prev) => {
				const current = new Set(prev[accountId] || []);
				current.delete(field);
				return { ...prev, [accountId]: current };
			});
			setChannelOverrides((prev) => {
				const updated = { ...prev };
				if (updated[accountId]) {
					const copy = { ...updated[accountId] };
					delete copy[field];
					if (Object.keys(copy).length === 0) {
						delete updated[accountId];
					} else {
						updated[accountId] = copy;
					}
				}
				return updated;
			});
		},
		[],
	);

	// Media handlers
	const handleAddMediaUrl = useCallback(
		(accountId: string, url: string) => {
			const type = inferMediaType(url);
			const item = { url, ...(type && { type }) };

			const isIgPost =
				activePlatforms.has("instagram") &&
				getOption("instagram", "content_type", "post") === "post";
			if (isIgPost && type === "video") {
				setError(
					"Videos are not supported for Instagram Posts. Use Reel or Story instead.",
				);
				return;
			}

			const isUnlinked = unlinkedFields[accountId]?.has("media");
			if (isUnlinked) {
				setChannelOverrides((prev) => ({
					...prev,
					[accountId]: {
						...prev[accountId],
						media: [...(prev[accountId]?.media || []), item],
					},
				}));
			} else {
				setSharedMedia((prev) => [...prev, item]);
			}
		},
		[unlinkedFields, activePlatforms, getOption],
	);

	const handleRemoveMedia = useCallback(
		(accountId: string, index: number) => {
			const isUnlinked = unlinkedFields[accountId]?.has("media");
			if (isUnlinked) {
				setChannelOverrides((prev) => ({
					...prev,
					[accountId]: {
						...prev[accountId],
						media: (prev[accountId]?.media || []).filter(
							(_, i) => i !== index,
						),
					},
				}));
			} else {
				setSharedMedia((prev) => prev.filter((_, i) => i !== index));
			}
		},
		[unlinkedFields],
	);

	const handleFileUpload = async (file: File) => {
		const type = inferMediaType(file.name);
		const isIgPost =
			activePlatforms.has("instagram") &&
			getOption("instagram", "content_type", "post") === "post";
		if (isIgPost && type === "video") {
			setError(
				"Videos are not supported for Instagram Posts. Use Reel or Story instead.",
			);
			return;
		}

		setUploading(true);
		try {
			let fileUrl: string | null = null;
			try {
				const presignRes = await fetch("/api/media/presign", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						filename: file.name,
						content_type: file.type,
					}),
				});
				if (presignRes.ok) {
					const { upload_url, url } = await presignRes.json();
					const uploadRes = await fetch(upload_url, {
						method: "PUT",
						headers: { "Content-Type": file.type },
						body: file,
					});
					if (uploadRes.ok) fileUrl = url;
				}
			} catch {
				// Presign not available — fall through
			}

			if (!fileUrl) {
				const res = await fetch(
					`/api/media/upload?filename=${encodeURIComponent(file.name)}`,
					{
						method: "POST",
						headers: { "Content-Type": file.type },
						body: file,
					},
				);
				if (!res.ok) {
					const err = await res.json().catch(() => null);
					throw new Error(err?.error?.message || "Failed to upload file");
				}
				const data = await res.json();
				fileUrl = data.url;
			}

			const mediaType = inferMediaType(file.name);
			const previewUrl = URL.createObjectURL(file);
			const item = {
				url: fileUrl!,
				previewUrl,
				...(mediaType && { type: mediaType }),
			};

			const isUnlinked =
				activeTabId && unlinkedFields[activeTabId]?.has("media");
			if (isUnlinked && activeTabId) {
				setChannelOverrides((prev) => ({
					...prev,
					[activeTabId]: {
						...prev[activeTabId],
						media: [...(prev[activeTabId]?.media || []), item],
					},
				}));
			} else {
				setSharedMedia((prev) => [...prev, item]);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : "Upload failed");
		} finally {
			setUploading(false);
		}
	};

	// Selection handlers
	const toggleAccount = (id: string, checked: boolean) => {
		setSelectedAccountIds((prev) =>
			checked ? [...prev, id] : prev.filter((a) => a !== id),
		);
		// When unchecking, remove parent workspaces so resolvedAccounts doesn't re-add via group expansion
		if (!checked) {
			setSelectedGroupIds((prev) => {
				const parentIds = groups
					.filter((g) => g.account_ids?.includes(id))
					.map((g) => g.id);
				if (parentIds.length === 0) return prev;
				return prev.filter((gid) => !parentIds.includes(gid));
			});
		}
	};

	const toggleGroup = (id: string, checked: boolean) => {
		setSelectedGroupIds((prev) =>
			checked ? [...prev, id] : prev.filter((g) => g !== id),
		);
		// Auto-select/deselect member accounts
		const group = groups.find((g) => g.id === id);
		if (group?.account_ids) {
			setSelectedAccountIds((prev) => {
				if (checked) {
					const next = new Set(prev);
					for (const aid of group.account_ids) next.add(aid);
					return [...next];
				}
				const toRemove = new Set(group.account_ids);
				return prev.filter((aid) => !toRemove.has(aid));
			});
		}
	};

	const deselectAll = () => {
		setSelectedAccountIds([]);
		setSelectedGroupIds([]);
	};

	// Validation
	const validate = (): string | null => {
		if (resolvedAccounts.length === 0) {
			return "Select at least one account or workspace.";
		}
		if (!sharedContent.trim() && sharedMedia.length === 0) {
			return "Add some content or media to your post.";
		}
		if (publishMode === "schedule" && !scheduledDate) {
			return "Select a date and time for scheduling.";
		}
		if (publishMode === "schedule" && scheduledDate && new Date(scheduledDate) <= new Date()) {
			return "Scheduled date must be in the future.";
		}
		if (publishMode === "schedule" && scheduledDate) {
			const maxDate = new Date();
			maxDate.setDate(maxDate.getDate() + 30);
			if (new Date(scheduledDate) > maxDate) {
				return "Posts can only be scheduled up to 30 days in advance.";
			}
		}

		for (const platform of activePlatforms) {
			const limit = PLATFORM_CHAR_LIMITS[platform];
			if (!limit) continue;

			for (const acc of resolvedAccounts) {
				if (acc.platform !== platform) continue;
				const effectiveContent =
					unlinkedFields[acc.id]?.has("content")
						? channelOverrides[acc.id]?.content ?? sharedContent
						: sharedContent;
				if (effectiveContent) {
					const count = countCharsForPlatform(effectiveContent, platform);
					if (count > limit.maxChars) {
						return `Content exceeds ${platformLabels[platform] || platform} limit of ${limit.maxChars} characters (${count}).`;
					}
				}
			}
		}

		if (activePlatforms.has("reddit") && !getOption("reddit", "subreddit")) {
			return "Reddit requires a subreddit.";
		}
		if (
			activePlatforms.has("pinterest") &&
			!getOption("pinterest", "board_id")
		) {
			return "Pinterest requires a board ID.";
		}
		if (activePlatforms.has("sms")) {
			const phones = getOption("sms", "phone_numbers", []);
			if (!Array.isArray(phones) || phones.length === 0) {
				return "SMS requires at least one phone number.";
			}
			if (!getOption("sms", "from_number")) {
				return "SMS requires a from number.";
			}
		}
		return null;
	};

	// Submit
	const handleSubmit = async () => {
		setSubmitting(true);
		setError(null);

		const validationError = validate();
		if (validationError) {
			setError(validationError);
			setSubmitting(false);
			return;
		}

		const builtTargetOptions: Record<string, Record<string, unknown>> = {};

		for (const [platform, opts] of Object.entries(targetOptions)) {
			if (!activePlatforms.has(platform)) continue;
			const cleaned: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(
				opts as Record<string, unknown>,
			)) {
				if (value === "" || value === undefined || value === null) continue;
				if (value === false) continue;
				if (Array.isArray(value) && value.length === 0) continue;
				cleaned[key] = value;
			}
			if (Object.keys(cleaned).length > 0)
				builtTargetOptions[platform] = cleaned;
		}

		for (const acc of resolvedAccounts) {
			const contentUnlinked = unlinkedFields[acc.id]?.has("content");
			const mediaUnlinked = unlinkedFields[acc.id]?.has("media");

			if (contentUnlinked || mediaUnlinked) {
				const accountOpts = builtTargetOptions[acc.id] || {};
				const overrides = channelOverrides[acc.id];
				if (contentUnlinked && overrides?.content !== undefined) {
					accountOpts.content = overrides.content;
				}
				if (mediaUnlinked && overrides?.media) {
					accountOpts.media = overrides.media;
				}
				if (Object.keys(accountOpts).length > 0) {
					builtTargetOptions[acc.id] = accountOpts;
				}
			}
		}

		const body: Record<string, unknown> = {
			targets: [...selectedAccountIds, ...selectedGroupIds],
			scheduled_at:
				publishMode === "now"
					? "now"
					: publishMode === "draft"
						? "draft"
						: new Date(scheduledDate).toISOString(),
		};

		if (sharedContent.trim()) body.content = sharedContent.trim();
		if (sharedMedia.length > 0)
			body.media = sharedMedia.map(({ url, type }) => ({
				url,
				...(type && { type }),
			}));
		if (publishMode === "schedule" && timezone) body.timezone = timezone;
		if (Object.keys(builtTargetOptions).length > 0)
			body.target_options = builtTargetOptions;
		if (slModeConfig === "always" || (slModeConfig === "ask" && shortenUrls))
			body.shorten_urls = true;
		const validActions = crossPostActions.filter((a) => a.target_account_id);
		if (validActions.length > 0) body.cross_post_actions = validActions;

		try {
			const isEditMode = !!editPostId;
			const isConvertMode = !!convertFromIdea && !isEditMode;

			let url: string;
			let method: string;
			let requestBody: Record<string, unknown>;

			if (isConvertMode) {
				url = `/api/ideas/${convertFromIdea.id}/convert`;
				method = "POST";
				requestBody = {
					targets: resolvedAccounts.map((a) => ({ account_id: a.id })),
					scheduled_at: body.scheduled_at,
					...(body.content ? { content: body.content } : {}),
					...(body.timezone ? { timezone: body.timezone } : {}),
				};
			} else {
				url = isEditMode ? `/api/posts/${editPostId}` : "/api/posts";
				method = isEditMode ? "PATCH" : "POST";
				requestBody = body;
			}

			const res = await fetch(url, {
				method,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(requestBody),
			});

			if (!res.ok) {
				const err = await res.json().catch(() => null);
				setError(err?.error?.message || `Error ${res.status}`);
				return;
			}

			const created = await res.json().catch(() => null);
			resetForm();
			onOpenChange(false);
			onCreated(created);
		} catch {
			setError("Network error. Please try again.");
		} finally {
			setSubmitting(false);
		}
	};

	// Reset
	const resetForm = useCallback(() => {
		setSharedContent("");
		setSharedMedia([]);
		setSelectedAccountIds([]);
		setSelectedGroupIds([]);
		setChannelOverrides({});
		setUnlinkedFields({});
		setTargetOptions({});
		setActiveTabId(null);
		setChannelPickerOpen(false);
		setChannelSearch("");
		setDebouncedSearch("");
		setPublishMode("now");
		setScheduledDate("");
		setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
		setShortenUrls(false);
		setCrossPostActions([]);
		setCrossPostExpanded(false);
		setError(null);
	}, []);

	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen) resetForm();
		onOpenChange(nextOpen);
	};

	const canSubmit =
		resolvedAccounts.length > 0 &&
		!submitting &&
		(publishMode !== "schedule" || scheduledDate !== "");

	const hasChannels = resolvedAccounts.length > 0;

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="max-w-2xl p-0 gap-0 max-h-[90vh] flex flex-col">
				<DialogHeader className="px-5 pt-5 pb-3 shrink-0">
					<DialogTitle className="text-base font-medium">
						{editPostId
							? "Edit Post"
							: convertFromIdea
								? "Convert Idea to Post"
								: "Create Post"}
					</DialogTitle>
				</DialogHeader>

				{/* Main content */}
				<div className="flex-1 min-h-0 overflow-y-auto">
					{/* Channel selector dropdown + tab bar */}
					<div className="px-5 pb-2">
						<Popover.Root
							open={channelPickerOpen}
							onOpenChange={setChannelPickerOpen}
						>
							{hasChannels ? (
								/* When channels are selected: show tab bar with inline + button as popover trigger */
								<div className="flex items-center gap-2 py-1 px-1 overflow-x-auto">
									{resolvedAccounts.map((account) => {
										const isActive = account.id === activeTabId;
										return (
											<button
												key={account.id}
												type="button"
												onClick={() => setActiveTabId(account.id)}
												className={cn(
													"relative shrink-0 rounded-full transition-all",
													isActive
														? "ring-2 ring-primary ring-offset-2 ring-offset-background"
														: "hover:ring-2 hover:ring-accent hover:ring-offset-1 hover:ring-offset-background opacity-60 hover:opacity-100",
												)}
												title={
													account.display_name ||
													account.username ||
													account.platform_account_id
												}
											>
												{account.avatar_url ? (
													<img
														src={account.avatar_url}
														alt=""
														className="size-9 rounded-full object-cover"
													/>
												) : (
													<div
														className={cn(
															"flex size-9 items-center justify-center rounded-full text-xs font-bold text-white",
															platformColors[account.platform] ||
																"bg-neutral-700",
														)}
													>
														{platformAvatars[account.platform] ||
															account.platform
																.slice(0, 2)
																.toUpperCase()}
													</div>
												)}
												<div
													className={cn(
														"absolute -bottom-0.5 -right-0.5 flex size-4.5 items-center justify-center rounded-full text-[6px] font-bold text-white ring-2 ring-background",
														platformColors[account.platform] ||
															"bg-neutral-700",
													)}
												>
													{platformAvatars[account.platform] ||
														account.platform
															.slice(0, 2)
															.toUpperCase()}
												</div>
											</button>
										);
									})}
									<Popover.Trigger asChild>
										<button
											type="button"
											className="flex size-9 items-center justify-center rounded-full border-2 border-dashed border-border text-muted-foreground hover:border-foreground hover:text-foreground transition-colors shrink-0"
											title="Add or remove channels"
										>
											<Plus className="size-4" />
										</button>
									</Popover.Trigger>
								</div>
							) : (
								/* When no channels: show the + circle */
								<div className="flex items-center gap-2 py-1 px-1">
									<Popover.Trigger asChild>
										<button
											type="button"
											className="flex size-9 items-center justify-center rounded-full border-2 border-dashed border-border text-muted-foreground hover:border-foreground hover:text-foreground transition-colors shrink-0"
											title="Add channels"
										>
											<Plus className="size-4" />
										</button>
									</Popover.Trigger>
								</div>
							)}

							<Popover.Portal>
								<Popover.Content
									side="bottom"
									align="start"
									sideOffset={6}
									className="z-50 w-[var(--radix-popover-trigger-width)] min-w-80 max-w-lg rounded-lg border border-border bg-popover shadow-lg animate-in fade-in-0 zoom-in-95 max-h-[60vh] overflow-hidden flex flex-col"
								>
									<div className="overflow-y-auto">
										<ChannelSelector
											accounts={accounts}
											workspaces={groups}
											selectedAccountIds={selectedAccountIds}
											selectedGroupIds={selectedGroupIds}
											onToggleAccount={toggleAccount}
											onToggleGroup={toggleGroup}
											onDeselectAll={deselectAll}
											loading={accountsLoading || groupsLoading}
											search={channelSearch}
											onSearchChange={handleSearchChange}
											accountsHasMore={accountsHasMore}
											accountsLoadMore={accountsLoadMore}
											accountsLoadingMore={accountsLoadingMore}
											workspacesHasMore={groupsHasMore}
											workspacesLoadMore={groupsLoadMore}
											workspacesLoadingMore={groupsLoadingMore}
										/>
									</div>
								</Popover.Content>
							</Popover.Portal>
						</Popover.Root>
					</div>

					{/* Editor (always visible) */}
					<ChannelEditor
						accounts={resolvedAccounts}
						activeTabId={activeTabId || ""}
						sharedContent={sharedContent}
						channelOverrides={channelOverrides}
						unlinkedFields={unlinkedFields}
						onContentChange={handleContentChange}
						onUnlinkField={handleUnlinkField}
						onRelinkField={handleRelinkField}
						sharedMedia={sharedMedia}
						onAddMediaUrl={handleAddMediaUrl}
						onRemoveMedia={handleRemoveMedia}
						onFileUpload={handleFileUpload}
						uploading={uploading}
						targetOptions={targetOptions}
						onSetOption={setOption}
						onGetOption={getOption}
						textareaRef={textareaRef}
					/>
				</div>

				{/* Cross-Post Actions (expanded panel) */}
				{publishMode !== "draft" && crossPostExpanded && (
					<div className="shrink-0">
						<CrossPostActionsPanel
							actions={crossPostActions}
							onChange={setCrossPostActions}
						/>
					</div>
				)}

				{/* Footer */}
				<div className="px-5 py-3 shrink-0 space-y-3">
					{error && (
						<p className="text-xs text-destructive">{error}</p>
					)}

					{publishMode === "schedule" && (
						<div className="flex flex-col sm:flex-row gap-2">
							<div className="flex-1">
								<input
									type="datetime-local"
									value={scheduledDate}
									onChange={(e) => setScheduledDate(e.target.value)}
									min={new Date().toISOString().slice(0, 16)}
								max={new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16)}
									className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
								/>
							</div>
							<div className="sm:w-36">
								<input
									type="text"
									value={timezone}
									onChange={(e) => setTimezone(e.target.value)}
									className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring font-mono text-[11px]"
									placeholder="Timezone"
								/>
							</div>
						</div>
					)}

					<div className="flex items-center justify-end gap-2">
						<div className="flex items-center gap-1 mr-auto">
							{!editPostId && (
								<Popover.Root open={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
									<Popover.Trigger asChild>
										<Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground">
											<FileText className="size-3.5" />
											Use Template
										</Button>
								</Popover.Trigger>
								<Popover.Portal>
									<Popover.Content
										className="z-50 w-72 rounded-lg border bg-popover p-0 shadow-lg"
										align="start"
										sideOffset={4}
										side="top"
									>
										<div className="p-2 border-b">
											<div className="relative">
												<Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
												<input
													className="w-full rounded-md border bg-transparent py-1.5 pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
													placeholder="Search templates..."
													value={templateSearch}
													onChange={(e) => setTemplateSearch(e.target.value)}
												/>
											</div>
										</div>
										<div className="max-h-48 overflow-y-auto p-1">
											{templatesLoading ? (
												<div className="flex items-center justify-center py-4">
													<Loader2 className="size-4 animate-spin text-muted-foreground" />
												</div>
											) : filteredTemplates.length === 0 ? (
												<p className="py-3 text-center text-xs text-muted-foreground">
													{templates.length === 0 ? "No templates yet" : "No matches"}
												</p>
											) : (
												filteredTemplates.map((tmpl) => (
													<button
														key={tmpl.id}
														type="button"
														className="w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60 transition-colors"
														onClick={() => applyTemplate(tmpl)}
													>
														<div className="font-medium truncate">{tmpl.name}</div>
														<div className="text-muted-foreground truncate mt-0.5">
															{tmpl.content.slice(0, 60)}
															{tmpl.content.length > 60 ? "..." : ""}
														</div>
													</button>
												))
											)}
										</div>
									</Popover.Content>
								</Popover.Portal>
								</Popover.Root>
							)}
							{publishMode !== "draft" && (
								<CrossPostActionsTrigger
									count={crossPostActions.length}
									onClick={() => {
										if (!crossPostExpanded && crossPostActions.length === 0) {
											setCrossPostActions([{ action_type: "repost", target_account_id: "", delay_minutes: 0 }]);
										}
										setCrossPostExpanded(!crossPostExpanded);
									}}
								/>
							)}
						</div>
						{/* Short links indicator */}
						{slModeConfig === "always" && (
							<span className="text-[11px] text-muted-foreground flex items-center gap-1">
								<Link2 className="size-3" />
								URLs will be shortened
							</span>
						)}
						{slModeConfig === "ask" && (
							<label className="flex items-center gap-1.5 cursor-pointer select-none">
								<button
									type="button"
									onClick={() => setShortenUrls(!shortenUrls)}
									className={cn(
										"relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
										shortenUrls ? "bg-primary" : "bg-accent/60 border border-border"
									)}
								>
									<span
										className={cn(
											"pointer-events-none inline-block size-3 rounded-full bg-white shadow-sm transition-transform",
											shortenUrls ? "translate-x-3.5" : "translate-x-0.5"
										)}
									/>
								</button>
								<span className="text-[11px] text-muted-foreground">Shorten URLs</span>
							</label>
						)}

						<Select
							value={publishMode}
							onValueChange={(v) => setPublishMode(v as PublishMode)}
						>
							<SelectTrigger
								size="sm"
								className="w-auto h-8 text-xs gap-1.5 border-border"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="now">
									<div className="flex items-center gap-1.5">
										<Send className="size-3" />
										Publish Now
									</div>
								</SelectItem>
								<SelectItem value="draft">
									<div className="flex items-center gap-1.5">
										<FileEdit className="size-3" />
										Save Draft
									</div>
								</SelectItem>
								<SelectItem value="schedule">
									<div className="flex items-center gap-1.5">
										<Clock className="size-3" />
										Schedule
									</div>
								</SelectItem>
							</SelectContent>
						</Select>

						<Button
							size="sm"
							className="h-8 text-xs gap-1.5"
							disabled={!canSubmit}
							onClick={handleSubmit}
						>
							{submitting && (
								<Loader2 className="size-3 animate-spin" />
							)}
							{editPostId
								? (publishMode === "now" ? "Publish" : publishMode === "draft" ? "Save Draft" : "Update")
								: (publishMode === "now" ? "Publish" : publishMode === "draft" ? "Save Draft" : "Schedule")}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
