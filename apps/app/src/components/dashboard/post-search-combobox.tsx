import { useState, useEffect, useRef, useCallback } from "react";
import { Search, FileText, Loader2, Check, X, Globe } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PostOption {
  /** Platform-native post ID */
  platformPostId: string;
  content: string | null;
  platform: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
}

interface PostSearchComboboxProps {
  value: string | null;
  onSelect: (platformPostId: string | null) => void;
  accountId: string | null;
  showAllOption?: boolean;
  placeholder?: string;
  className?: string;
  variant?: "default" | "input";
}

export function PostSearchCombobox({
  value,
  onSelect,
  accountId,
  showAllOption = true,
  placeholder = "All posts",
  className,
  variant = "default",
}: PostSearchComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [posts, setPosts] = useState<PostOption[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedPost = value ? posts.find((p) => p.platformPostId === value) : null;

  const fetchPosts = useCallback(
    async (query: string) => {
      if (!accountId) {
        setPosts([]);
        return;
      }
      setLoading(true);
      try {
        const url = new URL("/api/posts", window.location.origin);
        url.searchParams.set("account_id", accountId);
        url.searchParams.set("status", "published");
        url.searchParams.set("include", "targets,media");
        url.searchParams.set("include_external", "true");
        url.searchParams.set("limit", "30");
        const res = await fetch(url.toString());
        if (res.ok) {
          const json = await res.json();
          const items: PostOption[] = [];
          for (const post of json.data ?? []) {
            if (post.source === "external") {
              // External post — platform_post_id is directly on the post
              items.push({
                platformPostId: post.platform_post_id,
                content: post.content,
                platform: post.platform,
                thumbnailUrl:
                  post.media_urls?.[0] ?? post.thumbnail_url ?? null,
                publishedAt: post.published_at ?? null,
              });
            } else {
              // Internal post — extract platform_post_id from targets
              const targets = post.targets ?? {};
              for (const [platform, target] of Object.entries(targets) as [string, any][]) {
                const accounts = target.accounts ?? [];
                for (const acc of accounts) {
                  if (acc.id === accountId && acc.platform_post_id) {
                    items.push({
                      platformPostId: acc.platform_post_id,
                      content: post.content,
                      platform,
                      thumbnailUrl: post.media?.[0]?.url ?? null,
                      publishedAt: post.published_at ?? null,
                    });
                  }
                }
              }
            }
          }

          // Filter by search query client-side
          const filtered = query
            ? items.filter(
                (p) =>
                  p.content?.toLowerCase().includes(query.toLowerCase()) ||
                  p.platformPostId.toLowerCase().includes(query.toLowerCase()),
              )
            : items;

          // Deduplicate by platformPostId
          const seen = new Set<string>();
          const deduped = filtered.filter((p) => {
            if (seen.has(p.platformPostId)) return false;
            seen.add(p.platformPostId);
            return true;
          });

          setPosts(deduped);
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    },
    [accountId],
  );

  useEffect(() => {
    if (!open) return;
    fetchPosts(search);
  }, [open, accountId]);

  // Fetch on mount when value is pre-selected
  useEffect(() => {
    if (value && posts.length === 0 && accountId) {
      fetchPosts("");
    }
  }, [value, accountId]);

  // Reset when account changes
  useEffect(() => {
    setPosts([]);
    onSelect(null);
  }, [accountId]);

  const handleSearchChange = (val: string) => {
    setSearch(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchPosts(val), 300);
  };

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const handleSelect = (platformPostId: string | null) => {
    onSelect(platformPostId);
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
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const days = Math.floor(diffMs / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 30) return `${days}d ago`;
    return d.toLocaleDateString();
  }

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={!accountId}
        onClick={() => {
          setOpen(!open);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
        className={cn(
          "flex items-center gap-1.5 rounded-md text-muted-foreground transition-colors w-full text-left",
          variant === "input"
            ? "border border-border bg-background px-3 py-2 text-sm hover:border-ring"
            : "px-2.5 py-1.5 text-xs font-medium hover:bg-accent/50 hover:text-foreground",
          !accountId && "opacity-50 cursor-not-allowed",
        )}
      >
        <FileText className="size-3.5 shrink-0" />
        <span className="truncate flex-1">
          {selectedPost
            ? truncate(selectedPost.content, 40)
            : value
              ? value
              : placeholder}
        </span>
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

      {open && accountId && (
        <div className="absolute right-0 top-full mt-1.5 z-50 w-full min-w-[280px] rounded-lg border border-border bg-background shadow-lg">
          <div className="px-2.5 pt-2.5 pb-2">
            <div className="flex items-center gap-1.5 rounded-md bg-accent/40 px-2.5 py-1.5">
              <Search className="size-3.5 text-muted-foreground shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search posts..."
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setOpen(false);
                }}
              />
              {loading && (
                <Loader2 className="size-3 animate-spin text-muted-foreground" />
              )}
            </div>
          </div>

          <div className="max-h-56 overflow-y-auto py-1">
            {showAllOption && (
              <button
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/30 transition-colors",
                  value === null && "bg-accent/20 font-medium",
                )}
                onClick={() => handleSelect(null)}
              >
                <Check
                  className={cn(
                    "size-3 shrink-0",
                    value === null ? "opacity-100" : "opacity-0",
                  )}
                />
                <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                <span>All posts</span>
              </button>
            )}

            {posts.map((post) => (
              <button
                key={post.platformPostId}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent/30 transition-colors",
                  value === post.platformPostId && "bg-accent/20 font-medium",
                )}
                onClick={() => handleSelect(post.platformPostId)}
              >
                <Check
                  className={cn(
                    "size-3 shrink-0",
                    value === post.platformPostId
                      ? "opacity-100"
                      : "opacity-0",
                  )}
                />
                {post.thumbnailUrl ? (
                  <img
                    src={post.thumbnailUrl}
                    alt=""
                    className="size-8 rounded object-cover shrink-0"
                  />
                ) : (
                  <div className="flex size-8 items-center justify-center rounded bg-accent/30 shrink-0">
                    <FileText className="size-3.5 text-muted-foreground" />
                  </div>
                )}
                <div className="flex-1 text-left min-w-0">
                  <div className="truncate text-foreground">
                    {truncate(post.content, 50)}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {timeAgo(post.publishedAt)}
                  </div>
                </div>
              </button>
            ))}

            {!loading && posts.length === 0 && (
              <div className="px-3 py-3 text-xs text-muted-foreground text-center">
                {search ? "No posts found" : "No published posts for this account"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
