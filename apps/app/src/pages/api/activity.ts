import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

// Recent activity feed for the Overview page. There is no unified activity
// endpoint on the API, so we compose two existing SDK calls — recently published
// posts and connection events — and merge them by timestamp. Display strings
// (platform labels, titles) are built on the client from these raw fields.
type ActivityItem =
  | {
      id: string;
      kind: "post";
      event: "published";
      platforms: string[];
      text: string | null;
      timestamp: string;
    }
  | {
      id: string;
      kind: "connection";
      event: "connected" | "disconnected" | "token_refreshed" | "error";
      platforms: string[];
      text: string | null;
      timestamp: string;
    };

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;

  try {
    const url = new URL(ctx.request.url);
    const limit = Math.min(Number(url.searchParams.get("limit")) || 8, 50);

    const [postsRes, logsRes] = await Promise.allSettled([
      client.posts.list({ status: "published", limit, include: "targets" }),
      client.connections.listLogs({ limit }),
    ]);

    const items: ActivityItem[] = [];

    if (postsRes.status === "fulfilled") {
      for (const p of postsRes.value.data) {
        if (!p.published_at) continue;
        const platforms = p.targets
          ? [...new Set(Object.values(p.targets).map((t) => t.platform))]
          : [];
        items.push({
          id: `post_${p.id}`,
          kind: "post",
          event: "published",
          platforms,
          text: p.content ? p.content.replace(/\s+/g, " ").trim().slice(0, 140) : null,
          timestamp: p.published_at,
        });
      }
    }

    if (logsRes.status === "fulfilled") {
      for (const l of logsRes.value.data) {
        items.push({
          id: `log_${l.id}`,
          kind: "connection",
          event: l.event,
          platforms: l.platform ? [l.platform] : [],
          text: l.message,
          timestamp: l.created_at,
        });
      }
    }

    // ISO-8601 UTC strings sort lexically == chronologically. Newest first.
    items.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

    return Response.json(
      { data: items.slice(0, limit) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return handleSdkError(e);
  }
};
