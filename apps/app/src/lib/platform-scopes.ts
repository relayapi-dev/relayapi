type ScopeCategory = "posting" | "analytics" | "optional";

interface ScopeInfo {
  scope: string;
  label: string;
  category: ScopeCategory;
  group?: string;
}

const PLATFORM_SCOPE_MAP: Record<string, ScopeInfo[]> = {
  twitter: [
    { scope: "tweet.read", label: "Read tweets", category: "posting" },
    { scope: "tweet.write", label: "Write tweets", category: "posting" },
    { scope: "users.read", label: "Read user profile", category: "posting" },
    { scope: "offline.access", label: "Offline access", category: "optional" },
    { scope: "bookmark.write", label: "Manage bookmarks", category: "optional" },
    { scope: "follows.write", label: "Manage follows", category: "optional" },
    { scope: "dm.read", label: "Read direct messages", category: "optional" },
    { scope: "dm.write", label: "Send direct messages", category: "optional" },
  ],
  facebook: [
    { scope: "pages_manage_posts", label: "Manage page posts", category: "posting" },
    { scope: "pages_read_engagement", label: "Read page engagement", category: "posting" },
    { scope: "pages_show_list", label: "Show pages list", category: "posting" },
    { scope: "pages_read_user_content", label: "Read user content", category: "optional" },
    { scope: "read_insights", label: "Read insights", category: "analytics" },
    { scope: "pages_messaging", label: "Pages messaging", category: "optional" },
    { scope: "pages_manage_metadata", label: "Manage page metadata", category: "optional" },
  ],
  instagram: [
    // Facebook Login flow
    { scope: "instagram_basic", label: "instagram_basic", category: "posting", group: "facebook" },
    { scope: "instagram_content_publish", label: "instagram_content_publish", category: "posting", group: "facebook" },
    { scope: "pages_show_list", label: "pages_show_list", category: "posting", group: "facebook" },
    { scope: "pages_manage_posts", label: "pages_manage_posts", category: "posting", group: "facebook" },
    { scope: "instagram_manage_insights", label: "instagram_manage_insights", category: "analytics" },
    { scope: "instagram_manage_comments", label: "instagram_manage_comments", category: "optional" },
    { scope: "instagram_manage_messages", label: "instagram_manage_messages", category: "optional" },
    // Instagram Direct Login flow
    { scope: "instagram_business_basic", label: "instagram_business_basic", category: "posting", group: "direct" },
    { scope: "instagram_business_content_publish", label: "instagram_business_content_publish", category: "posting", group: "direct" },
    { scope: "instagram_business_manage_insights", label: "instagram_business_manage_insights", category: "analytics" },
    { scope: "instagram_business_manage_comments", label: "instagram_business_manage_comments", category: "optional" },
    { scope: "instagram_business_manage_messages", label: "instagram_business_manage_messages", category: "optional" },
  ],
  linkedin: [
    { scope: "openid", label: "OpenID", category: "posting" },
    { scope: "profile", label: "Profile access", category: "posting" },
    { scope: "w_member_social", label: "Post as member", category: "posting" },
    { scope: "w_organization_social", label: "Post as organization", category: "posting" },
    { scope: "r_organization_admin", label: "Read organization admin", category: "analytics" },
  ],
  tiktok: [
    { scope: "user.info.basic", label: "Basic user info", category: "posting" },
    { scope: "video.publish", label: "Publish videos", category: "posting" },
    { scope: "video.list", label: "List videos", category: "analytics" },
    { scope: "user.info.stats", label: "User statistics", category: "analytics" },
  ],
  youtube: [
    { scope: "https://www.googleapis.com/auth/youtube.upload", label: "Upload videos", category: "posting" },
    { scope: "https://www.googleapis.com/auth/youtube.readonly", label: "Read-only access", category: "posting" },
    { scope: "https://www.googleapis.com/auth/youtube.force-ssl", label: "Manage YouTube data", category: "posting" },
    { scope: "https://www.googleapis.com/auth/yt-analytics.readonly", label: "YouTube Analytics", category: "analytics" },
  ],
  pinterest: [
    { scope: "boards:read", label: "Read boards", category: "posting" },
    { scope: "pins:read", label: "Read pins", category: "posting" },
    { scope: "pins:write", label: "Write pins", category: "posting" },
    { scope: "user_accounts:read", label: "Read user account", category: "optional" },
  ],
  reddit: [
    { scope: "identity", label: "Identity", category: "posting" },
    { scope: "submit", label: "Submit posts", category: "posting" },
    { scope: "read", label: "Read content", category: "posting" },
    { scope: "mysubreddits", label: "My subreddits", category: "optional" },
    { scope: "flair", label: "Manage flair", category: "optional" },
  ],
  threads: [
    { scope: "threads_basic", label: "threads_basic", category: "posting" },
    { scope: "threads_content_publish", label: "threads_content_publish", category: "posting" },
    { scope: "threads_manage_insights", label: "threads_manage_insights", category: "analytics" },
  ],
  snapchat: [
    { scope: "snapchat-marketing-api", label: "Marketing API", category: "posting" },
  ],
  googlebusiness: [
    { scope: "https://www.googleapis.com/auth/business.manage", label: "Manage business", category: "posting" },
  ],
  mastodon: [
    { scope: "read:accounts", label: "Read accounts", category: "posting" },
    { scope: "write:statuses", label: "Write statuses", category: "posting" },
    { scope: "write:media", label: "Upload media", category: "posting" },
  ],
};

function getScopeInfo(platform: string, scope: string): ScopeInfo | null {
  const map = PLATFORM_SCOPE_MAP[platform];
  if (!map) return null;
  return map.find((s) => s.scope === scope) ?? null;
}

export function categorizeScopeList(
  platform: string,
  grantedScopes: string[],
): { posting: ScopeInfo[]; analytics: ScopeInfo[]; optional: ScopeInfo[] } {
  const result = { posting: [] as ScopeInfo[], analytics: [] as ScopeInfo[], optional: [] as ScopeInfo[] };
  const grantedSet = new Set(grantedScopes);

  // Add all known scopes for this platform, checking if they are granted
  const map = PLATFORM_SCOPE_MAP[platform] ?? [];
  const knownScopes = new Set(map.map((s) => s.scope));

  for (const info of map) {
    if (grantedSet.has(info.scope)) {
      result[info.category].push(info);
    }
  }

  // Any granted scopes not in the map go into optional
  for (const scope of grantedScopes) {
    if (!knownScopes.has(scope)) {
      result.optional.push({ scope, label: scope, category: "optional" });
    }
  }

  return result;
}

export function getExpectedScopes(
  platform: string,
): { posting: ScopeInfo[]; analytics: ScopeInfo[]; optional: ScopeInfo[] } {
  const result = { posting: [] as ScopeInfo[], analytics: [] as ScopeInfo[], optional: [] as ScopeInfo[] };
  const map = PLATFORM_SCOPE_MAP[platform] ?? [];
  for (const info of map) {
    result[info.category].push(info);
  }
  return result;
}

export function hasPostingCapability(platform: string, grantedScopes: string[]): boolean {
  const map = PLATFORM_SCOPE_MAP[platform];
  if (!map) return true; // Unknown platform, assume OK
  const postingScopes = map.filter((s) => s.category === "posting");
  if (postingScopes.length === 0) return true;
  const grantedSet = new Set(grantedScopes);

  // Group posting scopes by their group key (e.g. Instagram has "facebook" and "direct" login flows)
  const groups = new Map<string, ScopeInfo[]>();
  for (const s of postingScopes) {
    const key = s.group ?? "_";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  // Any one group being fully satisfied means posting is possible
  return Array.from(groups.values()).some((group) =>
    group.every((s) => grantedSet.has(s.scope)),
  );
}

export function hasAnalyticsCapability(platform: string, grantedScopes: string[]): boolean {
  const map = PLATFORM_SCOPE_MAP[platform];
  if (!map) return false;
  const analyticsScopes = map.filter((s) => s.category === "analytics");
  if (analyticsScopes.length === 0) return false;
  const grantedSet = new Set(grantedScopes);
  return analyticsScopes.some((s) => grantedSet.has(s.scope));
}
