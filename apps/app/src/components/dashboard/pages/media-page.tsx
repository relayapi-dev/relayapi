import { useState } from "react";
import { motion } from "motion/react";
import {
  Upload,
  Loader2,
  ImageIcon,
  Trash2,
  FileCheck,
  Hash,
  Type,
  BookOpen,
  Search,
  Wrench,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePaginatedApi } from "@/hooks/use-api";
import { FilterBar } from "@/components/dashboard/filter-bar";
import { useFilterQuery } from "@/components/dashboard/filter-context";
import { LoadMore } from "@/components/ui/load-more";
import { UploadMediaDialog } from "@/components/dashboard/upload-media-dialog";
import { PostLengthDialog } from "@/components/dashboard/tools/post-length-dialog";
import { MediaValidatorDialog } from "@/components/dashboard/tools/media-validator-dialog";
import { HashtagSafetyDialog } from "@/components/dashboard/tools/hashtag-safety-dialog";
import { SubredditInfoDialog } from "@/components/dashboard/tools/subreddit-info-dialog";
import { PostValidatorDialog } from "@/components/dashboard/tools/post-validator-dialog";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const } },
};

interface MediaFile {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  url: string;
  created_at: string;
}

const tabs = ["Library", "Tools"] as const;

const tools = [
  {
    id: "post-validator",
    label: "Post Validator",
    description: "Check if your post content meets platform requirements",
    icon: FileCheck,
  },
  {
    id: "media-validator",
    label: "Media Validator",
    description: "Verify media files meet platform specifications",
    icon: ImageIcon,
  },
  {
    id: "post-length",
    label: "Post Length Checker",
    description: "Check character limits across platforms",
    icon: Type,
  },
  {
    id: "hashtag-safety",
    label: "Hashtag Safety",
    description: "Check Instagram hashtag safety and reach",
    icon: Hash,
  },
  {
    id: "subreddit-info",
    label: "Subreddit Info",
    description: "Look up subreddit rules and posting guidelines",
    icon: Search,
  },
];

function formatFileSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function MediaPage() {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(() => {
    const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
    return params.get("tab") || "library";
  });

  const switchTab = (tab: string) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url.toString());
  };

  const filterQuery = useFilterQuery();

  const {
    data: media,
    loading,
    error,
    hasMore,
    loadMore,
    loadingMore,
    refetch,
  } = usePaginatedApi<MediaFile>(
    activeTab === "library" ? "media" : null,
    { query: filterQuery },
  );

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/media/${id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) refetch();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">Media</h1>
          <a href="https://docs.relayapi.dev/api-reference/media" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors"><BookOpen className="size-3.5" /></a>
        </div>
        {activeTab === "library" && (
          <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setUploadOpen(true)}>
            <Upload className="size-3.5" />
            Upload
          </Button>
        )}
      </div>

      <div className="flex items-end justify-between gap-x-4 border-b border-border overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        <div className="flex gap-4 shrink-0">
          {tabs.map((tab) => {
            const tabKey = tab.toLowerCase();
            return (
              <button
                key={tab}
                onClick={() => switchTab(tabKey)}
                className={cn(
                  "pb-2 text-[13px] font-medium transition-colors whitespace-nowrap border-b-2 -mb-px",
                  activeTab === tabKey
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {tab}
              </button>
            );
          })}
        </div>
        <div className="pb-2 shrink-0">
          <FilterBar />
        </div>
      </div>

      {activeTab === "library" && (
        <div className="flex items-start gap-2.5 rounded-md border border-border bg-accent/30 px-3.5 py-2.5 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0 mt-0.5" />
          <p>Files are temporary and automatically deleted after 30 days. Upload media when you're ready to publish your posts.</p>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Library tab */}
      {activeTab === "library" && (
        loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : media.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-12 text-center">
            <ImageIcon className="size-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No media files</p>
            <p className="text-xs text-muted-foreground mt-1">
              Upload images and videos to use in your posts
            </p>
          </div>
        ) : (
          <>
            <motion.div
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              variants={stagger}
              initial="hidden"
              animate="visible"
            >
              {media.map((file) => (
                <motion.div
                  key={file.id}
                  variants={fadeUp}
                  className="group rounded-md border border-border overflow-hidden hover:bg-accent/20 transition-colors"
                >
                  <div className="aspect-video bg-accent/20 flex items-center justify-center">
                    {file.mime_type?.startsWith("image/") ? (
                      <img
                        src={file.url}
                        alt={file.filename}
                        className="size-full object-cover"
                        onError={(e) => {
                          const target = e.currentTarget;
                          target.style.display = "none";
                          target.nextElementSibling?.classList.remove("hidden");
                        }}
                      />
                    ) : null}
                    {!file.mime_type?.startsWith("image/") ? (
                      <ImageIcon className="size-8 text-muted-foreground/40" />
                    ) : (
                      <ImageIcon className="size-8 text-muted-foreground/40 hidden" />
                    )}
                  </div>
                  <div className="p-3 flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{file.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatFileSize(file.size)} &middot; {file.mime_type}
                      </p>
                    </div>
                    <button
                      className="rounded-lg p-1.5 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100 shrink-0"
                      onClick={() => handleDelete(file.id)}
                      title="Delete"
                    >
                      <Trash2 className="size-4 text-muted-foreground hover:text-red-400" />
                    </button>
                  </div>
                </motion.div>
              ))}
            </motion.div>
            <LoadMore
              hasMore={hasMore}
              loading={loadingMore}
              onLoadMore={loadMore}
              count={media.length}
            />
          </>
        )
      )}

      {/* Tools tab */}
      {activeTab === "tools" && (
        <motion.div
          className="grid gap-3 sm:grid-cols-2"
          variants={stagger}
          initial="hidden"
          animate="visible"
        >
          {tools.map((tool) => {
            const Icon = tool.icon;
            return (
              <motion.div
                key={tool.id}
                variants={fadeUp}
                className="rounded-md border border-border p-4 hover:bg-accent/20 transition-colors cursor-pointer"
                onClick={() => setOpenTool(tool.id)}
              >
                <div className="flex items-start gap-3">
                  <div className="rounded-md bg-primary/10 p-2 shrink-0">
                    <Icon className="size-4 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-sm font-medium">{tool.label}</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {tool.description}
                    </p>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      )}

      <UploadMediaDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUploaded={refetch}
      />

      <PostLengthDialog
        open={openTool === "post-length"}
        onOpenChange={(v) => !v && setOpenTool(null)}
      />
      <MediaValidatorDialog
        open={openTool === "media-validator"}
        onOpenChange={(v) => !v && setOpenTool(null)}
      />
      <HashtagSafetyDialog
        open={openTool === "hashtag-safety"}
        onOpenChange={(v) => !v && setOpenTool(null)}
      />
      <SubredditInfoDialog
        open={openTool === "subreddit-info"}
        onOpenChange={(v) => !v && setOpenTool(null)}
      />
      <PostValidatorDialog
        open={openTool === "post-validator"}
        onOpenChange={(v) => !v && setOpenTool(null)}
      />
    </div>
  );
}
