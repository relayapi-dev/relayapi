import { useState, createContext, useContext, lazy, Suspense } from "react";
import { Key, Loader2, WifiOff, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUsage } from "@/hooks/use-usage";
import { useUser } from "./user-context";

// Lazy-load all pages — only the active page's JS is fetched on navigation
const PostsPage = lazy(() => import("./pages/posts-page").then((m) => ({ default: m.PostsPage })));
const ConnectionsPage = lazy(() => import("./pages/connections-page").then((m) => ({ default: m.ConnectionsPage })));
const AnalyticsPage = lazy(() => import("./pages/analytics-page").then((m) => ({ default: m.AnalyticsPage })));
const ApiKeysPage = lazy(() => import("./pages/api-keys-page").then((m) => ({ default: m.ApiKeysPage })));
const SchedulingPage = lazy(() => import("./pages/scheduling-page").then((m) => ({ default: m.SchedulingPage })));
const TeamPage = lazy(() => import("./pages/team-page").then((m) => ({ default: m.TeamPage })));
const WebhooksPage = lazy(() => import("./pages/webhooks-page").then((m) => ({ default: m.WebhooksPage })));
const LogsPage = lazy(() => import("./pages/logs-page").then((m) => ({ default: m.LogsPage })));
const ProfilePage = lazy(() => import("./pages/profile-page").then((m) => ({ default: m.ProfilePage })));
const SettingsPage = lazy(() => import("./pages/settings-page").then((m) => ({ default: m.SettingsPage })));
const BillingPage = lazy(() => import("./pages/billing-page").then((m) => ({ default: m.BillingPage })));
const MediaPage = lazy(() => import("./pages/media-page").then((m) => ({ default: m.MediaPage })));
const WhatsAppPage = lazy(() => import("./pages/whatsapp-page").then((m) => ({ default: m.WhatsAppPage })));
const CampaignsPage = lazy(() => import("./pages/campaigns-page").then((m) => ({ default: m.CampaignsPage })));
const ContactsPage = lazy(() => import("./pages/contacts-page").then((m) => ({ default: m.ContactsPage })));
const NotificationsPage = lazy(() => import("./pages/notifications-page").then((m) => ({ default: m.NotificationsPage })));
const AdminUsersPage = lazy(() => import("./pages/admin/admin-users-page").then((m) => ({ default: m.AdminUsersPage })));
const AdminOrganizationsPage = lazy(() => import("./pages/admin/admin-organizations-page").then((m) => ({ default: m.AdminOrganizationsPage })));
const AdminPlansPage = lazy(() => import("./pages/admin/admin-plans-page").then((m) => ({ default: m.AdminPlansPage })));
const TemplatesPage = lazy(() => import("./pages/templates-page").then((m) => ({ default: m.TemplatesPage })));
const AdsPage = lazy(() => import("./pages/ads-page").then((m) => ({ default: m.AdsPage })));
const InboxCommentsPage = lazy(() => import("./pages/inbox-comments-page").then((m) => ({ default: m.InboxCommentsPage })));
const InboxMessagesPage = lazy(() => import("./pages/inbox-messages-page").then((m) => ({ default: m.InboxMessagesPage })));
const InboxReviewsPage = lazy(() => import("./pages/inbox-reviews-page").then((m) => ({ default: m.InboxReviewsPage })));

const pages: Record<string, React.ComponentType> = {
  posts: PostsPage,
  connections: ConnectionsPage,
  analytics: AnalyticsPage,
  "api-keys": ApiKeysPage,
  scheduling: SchedulingPage,
  team: TeamPage,
  webhooks: WebhooksPage,
  logs: LogsPage,
  profile: ProfilePage,
  "settings": SettingsPage,
  billing: BillingPage,
  media: MediaPage,

  whatsapp: WhatsAppPage,
  templates: TemplatesPage,
  ads: AdsPage,
  "inbox-comments": InboxCommentsPage,
  "inbox-messages": InboxMessagesPage,
  "inbox-reviews": InboxReviewsPage,
  campaigns: CampaignsPage,
  contacts: ContactsPage,
  notifications: NotificationsPage,
  "admin-users": AdminUsersPage,
  "admin-organizations": AdminOrganizationsPage,
  "admin-plans": AdminPlansPage,
};

// Pages that don't need an API key (use Better Auth directly or have no API backing)
const noKeyPages = new Set(["team", "settings", "profile", "billing", "notifications", "admin-users", "admin-organizations", "admin-plans"]);
const adminPages = new Set(["admin-users", "admin-organizations", "admin-plans"]);

// Derives key status from the shared UsageProvider — no extra fetch
type KeyStatus = "loading" | "ok" | "no_key" | "unreachable";

function BootstrapKeyBanner() {
  const [creating, setCreating] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/bootstrap-key", { method: "POST" });
      if (res.ok) {
        setDone(true);
        setTimeout(() => window.location.reload(), 500);
      } else {
        const data = await res.json().catch(() => null);
        setError(data?.error || "Failed to create API key");
      }
    } catch {
      setError("Network error");
    } finally {
      setCreating(false);
    }
  };

  if (done) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center py-20">
      <div className="text-center max-w-sm">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/10">
          <Key className="size-6 text-primary" />
        </div>
        <h2 className="text-lg font-medium">Set up API access</h2>
        <p className="text-sm text-muted-foreground mt-2">
          Your dashboard needs an API key to display data. Click below to create one automatically.
        </p>
        {error && (
          <p className="text-sm text-destructive mt-3">{error}</p>
        )}
        <Button
          className="mt-4 gap-2"
          onClick={handleCreate}
          disabled={creating}
        >
          {creating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Key className="size-4" />
          )}
          {creating ? "Creating..." : "Create Dashboard Key"}
        </Button>
      </div>
    </div>
  );
}

function ApiUnreachableBanner() {
  const { refetch: retry } = useUsage();
  return (
    <div className="flex items-center justify-center py-20">
      <div className="text-center max-w-sm">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-destructive/10">
          <WifiOff className="size-6 text-destructive" />
        </div>
        <h2 className="text-lg font-medium">API server unreachable</h2>
        <p className="text-sm text-muted-foreground mt-2">
          Cannot connect to the API server. Make sure it is running and try again.
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={retry}
        >
          Retry
        </Button>
      </div>
    </div>
  );
}

function AccessDenied() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="text-center max-w-sm">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-destructive/10">
          <ShieldAlert className="size-6 text-destructive" />
        </div>
        <h2 className="text-lg font-medium">Access Denied</h2>
        <p className="text-sm text-muted-foreground mt-2">
          You don't have permission to access this page.
        </p>
      </div>
    </div>
  );
}

const PageFallback = () => (
  <div className="flex items-center justify-center py-20">
    <Loader2 className="size-5 animate-spin text-muted-foreground" />
  </div>
);

export function PageContent({ page }: { page: string }) {
  const user = useUser();
  const Component = pages[page] || PostsPage;

  if (adminPages.has(page) && user?.role !== "admin") {
    return <AccessDenied />;
  }

  if (noKeyPages.has(page)) {
    return (
      <Suspense fallback={<PageFallback />}>
        <Component />
      </Suspense>
    );
  }

  return <PageWithKeyCheck Component={Component} />;
}

function PageWithKeyCheck({ Component }: { Component: React.ComponentType }) {
  const { usage, loading, error } = useUsage();

  // Don't block on loading — render the page immediately.
  // Only show blocking banners for definitive errors (no key / unreachable).
  if (!loading && error) {
    if (error.includes("No dashboard API key") || error.includes("NO_API_KEY") || error.includes("Invalid API key")) {
      return <BootstrapKeyBanner />;
    }
    if (error.includes("API server") || error.includes("NETWORK_ERROR") || error.includes("Network connection")) {
      return <ApiUnreachableBanner />;
    }
  }

  return (
    <Suspense fallback={<PageFallback />}>
      <Component />
    </Suspense>
  );
}
