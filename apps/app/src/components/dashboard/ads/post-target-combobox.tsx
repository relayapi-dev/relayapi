import { useState, useEffect, useRef, useCallback } from "react";
import { Search, FileText, Loader2, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { platformColors, platformLabels, platformAvatars } from "@/lib/platform-maps";

interface PostTargetOption {
  /**
   * The value submitted to /v1/ads/boost. For RelayAPI posts this is the post
   * target ID (pt_); for native/external posts it's the external post ID (xp_).
   * The dialog picks post_target_id vs external_post_id by this prefix.
   */
  id: string;
  source: "internal" | "external";
  platformPostId: string;
  platform: string;
  accountName: string | null;
  content: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
}

interface PostTargetComboboxProps {
  value: string | null;
  onSelect: (postTargetId: string | null) => void;
  /** Social platforms the selected ad account can boost (e.g. ["facebook","instagram"]). Undefined = no filter. */
  platforms?: string[];
  /**
   * Connected social account IDs the selected ad account can boost. Undefined =
   * no account filter; an empty array shows no posts (account boosts nothing).
   */
  accountIds?: string[];
  placeholder?: string;
  className?: string;
}

export function PostTargetCombobox({
  value,
  onSelect,
  platforms,
  accountIds,
  placeholder = "Select a published post...",
  className,
}: PostTargetComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [posts, setPosts] = useState<PostTargetOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [brokenThumbs, setBrokenThumbs] = useState<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Collapse platforms to a stable dependency key.
  // "*" = no filter (undefined); "" = filter out everything (empty array).
  const platformsKey = platforms === undefined ? "*" : [...platforms].sort().join("|");
  // Same convention for the connected-account filter (the ad account's boostable set).
  const accountIdsKey = accountIds === undefined ? "*" : [...accountIds].sort().join("|");

  const selectedPost = value ? posts.find((p) => p.id === value) : null;

  const fetchPosts = useCallback(async () => {
    setLoading(true);
    try {
      const accountFilter =
        accountIdsKey === "*"
          ? null
          : new Set(accountIdsKey ? accountIdsKey.split("|") : []);
      const url = new URL("/api/posts", window.location.origin);
      url.searchParams.set("status", "published");
      url.searchParams.set("include", "targets,media");
      // Include natively-published posts (external_posts) so they're boostable too.
      url.searchParams.set("include_external", "true");
      url.searchParams.set("limit", "100");
      // Scope to the ad account's boostable connected accounts (server-side, so
      // it stays correct beyond the 100-post fetch window).
      if (accountFilter && accountFilter.size > 0) {
        url.searchParams.set("account_ids", [...accountFilter].join(","));
      }
      const res = await fetch(url.toString());
      if (res.ok) {
        const json = await res.json();
        const allowed =
          platformsKey === "*" ? null : new Set(platformsKey ? platformsKey.split("|") : []);
        const items: PostTargetOption[] = [];
        for (const post of json.data ?? []) {
          // Native/external posts: boosted via external_post_id (xp_).
          if (post.source === "external") {
            if (!post.platform_post_id) continue;
            if (allowed && !allowed.has(post.platform)) continue;
            if (accountFilter && !accountFilter.has(post.social_account_id)) continue;
            items.push({
              id: post.id, // xp_
              source: "external",
              platformPostId: post.platform_post_id,
              platform: post.platform,
              accountName: post.account_name ?? null,
              content: post.content ?? null,
              thumbnailUrl: post.thumbnail_url ?? post.media_urls?.[0] ?? null,
              publishedAt: post.published_at ?? null,
            });
            continue;
          }
          // RelayAPI posts: boosted via post target id (pt_).
          const targets = post.targets ?? {};
          for (const target of Object.values(targets) as any[]) {
            if (target?.status !== "published") continue;
            if (allowed && !allowed.has(target.platform)) continue;
            for (const acc of target.accounts ?? []) {
              if (!acc.target_id || !acc.platform_post_id) continue;
              // acc.id is the social account id; keep only boostable accounts.
              if (accountFilter && !accountFilter.has(acc.id)) continue;
              items.push({
                id: acc.target_id, // pt_
                source: "internal",
                platformPostId: acc.platform_post_id,
                platform: target.platform,
                accountName: acc.display_name ?? acc.username ?? null,
                content: post.content ?? null,
                thumbnailUrl: post.media?.[0]?.url ?? null,
                publishedAt: post.published_at ?? null,
              });
            }
          }
        }
        // Deduplicate by id (pt_/xp_ are unique per post+account)
        const seen = new Set<string>();
        setPosts(
          items.filter((p) => {
            if (seen.has(p.id)) return false;
            seen.add(p.id);
            return true;
          }),
        );
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [platformsKey, accountIdsKey]);

  // Fetch when the dropdown opens
  useEffect(() => {
    if (open) fetchPosts();
  }, [open, fetchPosts]);

  // Clear the selection when the ad account changes (different compatible
  // platforms or boostable accounts), so an incompatible target can't be
  // submitted. Skip the initial mount.
  const filterKey = `${platformsKey}::${accountIdsKey}`;
  const prevFilterKeyRef = useRef(filterKey);
  useEffect(() => {
    if (prevFilterKeyRef.current === filterKey) return;
    prevFilterKeyRef.current = filterKey;
    setPosts([]);
    onSelect(null);
  }, [filterKey, onSelect]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const handleSelect = (targetId: string | null) => {
    onSelect(targetId);
    setOpen(false);
    setSearch("");
  };

  function truncate(text: string | null, max: number) {
    if (!text) return "No caption";
    return text.length > max ? `${text.slice(0, max)}...` : text;
  }

  function timeAgo(dateStr: string | null) {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    const diffMs = Date.now() - d.getTime();
    const days = Math.floor(diffMs / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 30) return `${days}d ago`;
    return d.toLocaleDateString();
  }

  const filtered = search
    ? posts.filter(
        (p) =>
          p.content?.toLowerCase().includes(search.toLowerCase()) ||
          p.accountName?.toLowerCase().includes(search.toLowerCase()) ||
          p.platformPostId.toLowerCase().includes(search.toLowerCase()),
      )
    : posts;

  function platformBadge(platform: string) {
    return (
      <div
        className={cn(
          "flex size-4 items-center justify-center rounded-full text-[8px] font-bold text-white shrink-0",
          platformColors[platform] ?? "bg-neutral-600",
        )}
        title={platformLabels[platform] ?? platform}
      >
        {platformAvatars[platform] ?? platform.slice(0, 1).toUpperCase()}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
        className="flex h-9 w-full items-center gap-1.5 rounded-md border border-input bg-transparent px-3 text-sm text-muted-foreground transition-colors hover:text-foreground text-left"
      >
        <FileText className="size-3.5 shrink-0" />
        <span className="truncate flex-1">
          {selectedPost ? truncate(selectedPost.content, 40) : value ? value : placeholder}
        </span>
        {selectedPost && platformBadge(selectedPost.platform)}
        {value ? (
          <X
            className="size-3 hover:text-foreground shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              handleSelect(null);
            }}
          />
        ) : (
          <Search className="size-3 shrink-0 opacity-50" />
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-50 w-full min-w-[280px] rounded-lg border border-border bg-background shadow-lg">
          <div className="px-2.5 pt-2.5 pb-2">
            <div className="flex items-center gap-1.5 rounded-md bg-accent/40 px-2.5 py-1.5">
              <Search className="size-3.5 text-muted-foreground shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search posts..."
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setOpen(false);
                }}
              />
              {loading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
            </div>
          </div>

          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.map((post) => (
              <button
                key={post.id}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent/30 transition-colors",
                  value === post.id && "bg-accent/20 font-medium",
                )}
                onClick={() => handleSelect(post.id)}
              >
                <Check
                  className={cn(
                    "size-3 shrink-0",
                    value === post.id ? "opacity-100" : "opacity-0",
                  )}
                />
                {post.thumbnailUrl && !brokenThumbs.has(post.id) ? (
                  <img
                    src={post.thumbnailUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                    onError={() =>
                      setBrokenThumbs((prev) => {
                        const next = new Set(prev);
                        next.add(post.id);
                        return next;
                      })
                    }
                    className="size-8 rounded object-cover shrink-0"
                  />
                ) : (
                  <div className="flex size-8 items-center justify-center rounded bg-accent/30 shrink-0">
                    <FileText className="size-3.5 text-muted-foreground" />
                  </div>
                )}
                <div className="flex-1 text-left min-w-0">
                  <div className="truncate text-foreground">{truncate(post.content, 50)}</div>
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-0.5">
                    {platformBadge(post.platform)}
                    {post.accountName && <span className="truncate">{post.accountName}</span>}
                    {post.publishedAt && <span>· {timeAgo(post.publishedAt)}</span>}
                  </div>
                </div>
              </button>
            ))}

            {!loading && filtered.length === 0 && (
              <div className="px-3 py-3 text-xs text-muted-foreground text-center">
                {search ? "No posts found" : "No boostable posts for this ad account"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
