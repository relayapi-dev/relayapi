import { useState, useEffect, useCallback, useRef } from "react";
import { motion } from "motion/react";
import { Bell, Building2, Camera, Check, Link2, Loader2, Pen, Plus, Shield, Star, Trash2, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { organization as orgClient, useSession } from "@/lib/auth-client";
import { slugify, getOrgColor } from "@/types/dashboard";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const },
  },
};

function Toggle({
  enabled,
  onToggle,
  disabled,
}: {
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
        enabled ? "bg-primary" : "bg-accent/60 border border-border",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
          enabled ? "translate-x-[18px]" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

interface ChannelPrefs {
  push: boolean;
  email: boolean;
}

interface NotificationPrefs {
  postFailures: ChannelPrefs;
  postPublished: ChannelPrefs;
  accountDisconnects: ChannelPrefs;
  paymentAlerts: ChannelPrefs;
  usageAlerts: ChannelPrefs;
  streakWarnings: ChannelPrefs;
  weeklyDigest: ChannelPrefs;
  marketing: ChannelPrefs;
}

const NOTIFICATION_TYPES: {
  key: keyof NotificationPrefs;
  label: string;
  description: string;
  emailAlwaysOn?: boolean;
}[] = [
  {
    key: "postFailures",
    label: "Post Failures",
    description: "Get notified when scheduled posts fail to publish",
  },
  {
    key: "postPublished",
    label: "Post Published",
    description: "Get notified when posts are published successfully",
  },
  {
    key: "accountDisconnects",
    label: "Account Disconnects",
    description: "Get notified when social accounts get disconnected",
  },
  {
    key: "paymentAlerts",
    label: "Payment Alerts",
    description: "Get notified when subscription payments fail",
    emailAlwaysOn: true,
  },
  {
    key: "usageAlerts",
    label: "Usage Alerts",
    description: "Receive warnings when approaching or reaching your plan limits",
  },
  {
    key: "streakWarnings",
    label: "Streak Warnings",
    description: "Get notified when your posting streak is about to end or has ended",
  },
  {
    key: "weeklyDigest",
    label: "Weekly Digest",
    description: "Weekly summary of your posting activity and analytics",
  },
  {
    key: "marketing",
    label: "Marketing Emails",
    description: "Occasional product updates, tips, and promotional emails",
  },
];

interface Signature {
  id: string;
  name: string;
  content: string;
  is_default: boolean;
  position: "append" | "prepend";
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export function SettingsPage() {
  const { data: session } = useSession();
  const activeOrg = session?.session?.activeOrganizationId;

  // Org profile
  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [orgLogo, setOrgLogo] = useState<string | null>(null);
  const [orgLoading, setOrgLoading] = useState(true);
  const [orgNameSaving, setOrgNameSaving] = useState(false);
  const [orgNameSuccess, setOrgNameSuccess] = useState(false);
  const [orgNameError, setOrgNameError] = useState("");
  const [orgSlugSaving, setOrgSlugSaving] = useState(false);
  const [orgSlugSuccess, setOrgSlugSuccess] = useState(false);
  const [orgSlugError, setOrgSlugError] = useState("");
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState("");
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [originalOrgName, setOriginalOrgName] = useState("");
  const [originalOrgSlug, setOriginalOrgSlug] = useState("");
  const [orgId, setOrgId] = useState("");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    if (!activeOrg) return;
    orgClient.getFullOrganization({}).then(({ data }) => {
      if (data) {
        setOrgName(data.name);
        setOriginalOrgName(data.name);
        setOrgSlug(data.slug);
        setOriginalOrgSlug(data.slug);
        setOrgLogo(data.logo || null);
        setOrgId(data.id);
      }
    }).catch(() => {}).finally(() => setOrgLoading(false));
  }, [activeOrg]);

  const handleUpdateOrgName = async () => {
    if (!orgName.trim() || orgName === originalOrgName) return;
    setOrgNameSaving(true);
    setOrgNameSuccess(false);
    setOrgNameError("");
    try {
      const { error } = await orgClient.update({ data: { name: orgName.trim() } });
      if (error) {
        setOrgNameError(error.message || "Failed to update name");
      } else {
        setOriginalOrgName(orgName.trim());
        setOrgNameSuccess(true);
        setTimeout(() => setOrgNameSuccess(false), 2000);
      }
    } catch {
      setOrgNameError("Failed to update name");
    } finally {
      setOrgNameSaving(false);
    }
  };

  const handleUpdateOrgSlug = async () => {
    if (!orgSlug.trim() || orgSlug === originalOrgSlug) return;
    setOrgSlugSaving(true);
    setOrgSlugSuccess(false);
    setOrgSlugError("");
    try {
      const { error } = await orgClient.update({ data: { slug: orgSlug.trim() } });
      if (error) {
        setOrgSlugError(error.message || "Failed to update slug");
      } else {
        setOriginalOrgSlug(orgSlug.trim());
        setOrgSlugSuccess(true);
        setTimeout(() => setOrgSlugSuccess(false), 2000);
      }
    } catch {
      setOrgSlugError("Failed to update slug");
    } finally {
      setOrgSlugSaving(false);
    }
  };

  const handleLogoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setLogoError("File must be under 2MB");
      return;
    }
    const validTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (!validTypes.includes(file.type)) {
      setLogoError("Only JPEG, PNG, GIF, or WebP allowed");
      return;
    }
    setLogoUploading(true);
    setLogoError("");
    try {
      const res = await fetch("/api/org/logo", {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || "Upload failed");
      }
      const { url } = await res.json();
      const logoUrl = `${url}?t=${Date.now()}`;
      const { error } = await orgClient.update({ data: { logo: logoUrl } });
      if (error) throw new Error(error.message || "Failed to update logo");
      setOrgLogo(logoUrl);
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setLogoUploading(false);
      if (logoInputRef.current) logoInputRef.current.value = "";
    }
  };

  const handleRemoveLogo = async () => {
    setLogoUploading(true);
    setLogoError("");
    try {
      await fetch("/api/org/logo", { method: "DELETE" });
      const { error } = await orgClient.update({ data: { logo: null as unknown as string } });
      if (error) throw new Error(error.message || "Failed to remove logo");
      setOrgLogo(null);
    } catch {
      setLogoError("Failed to remove logo");
    } finally {
      setLogoUploading(false);
    }
  };

  const handleDeleteOrg = async () => {
    if (deleteConfirmText !== orgName) return;
    setDeleteLoading(true);
    setDeleteError("");
    try {
      const { error } = await orgClient.delete({ organizationId: orgId });
      if (error) {
        setDeleteError(error.message || "Failed to delete organization");
        setDeleteLoading(false);
        return;
      }
      window.location.href = "/app";
    } catch {
      setDeleteError("Failed to delete organization");
      setDeleteLoading(false);
    }
  };

  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [prefsLoading, setPrefsLoading] = useState(true);
  const [prefsError, setPrefsError] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Org settings
  const [requireWorkspaceId, setRequireWorkspaceId] = useState(false);
  const [orgSettingsLoading, setOrgSettingsLoading] = useState(true);
  const [orgSettingsSaving, setOrgSettingsSaving] = useState(false);

  useEffect(() => {
    fetch("/api/org-settings")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.data) setRequireWorkspaceId(data.data.require_workspace_id);
      })
      .catch(() => {})
      .finally(() => setOrgSettingsLoading(false));
  }, []);

  const toggleRequireWorkspaceId = useCallback(() => {
    const newValue = !requireWorkspaceId;
    setRequireWorkspaceId(newValue);
    setOrgSettingsSaving(true);
    fetch("/api/org-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ require_workspace_id: newValue }),
    })
      .catch(() => setRequireWorkspaceId(!newValue))
      .finally(() => setOrgSettingsSaving(false));
  }, [requireWorkspaceId]);

  // Short links config
  const [slMode, setSlMode] = useState<"always" | "ask" | "never">("never");
  const [slProvider, setSlProvider] = useState<string>("");
  const [slApiKey, setSlApiKey] = useState("");
  const [slDomain, setSlDomain] = useState("");
  const [slHasKey, setSlHasKey] = useState(false);
  const [slEditingKey, setSlEditingKey] = useState(false);
  const [slLoading, setSlLoading] = useState(true);
  const [slSaving, setSlSaving] = useState(false);
  const [slSaveSuccess, setSlSaveSuccess] = useState(false);
  const [slError, setSlError] = useState("");
  const [slTesting, setSlTesting] = useState(false);
  const [slTestResult, setSlTestResult] = useState<{ success: boolean; short_url?: string | null; error?: string | null } | null>(null);

  useEffect(() => {
    fetch("/api/short-links/config")
      .then((r) => {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((data) => {
        if (data) {
          setSlMode(data.mode);
          setSlProvider(data.provider || "");
          setSlDomain(data.domain || "");
          setSlHasKey(data.has_api_key);
        }
      })
      .catch(() => {})
      .finally(() => setSlLoading(false));
  }, []);

  const handleSaveShortLinks = async () => {
    setSlSaving(true);
    setSlError("");
    setSlSaveSuccess(false);
    try {
      const body: Record<string, unknown> = { mode: slMode };
      if (slProvider) body.provider = slProvider;
      if (slApiKey) body.api_key = slApiKey;
      if (slDomain) body.domain = slDomain;

      const res = await fetch("/api/short-links/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setSlError(err?.error?.message || `Error ${res.status}`);
        return;
      }
      const data = await res.json();
      setSlHasKey(data.has_api_key);
      setSlApiKey("");
      setSlEditingKey(false);
      setSlSaveSuccess(true);
      setTimeout(() => setSlSaveSuccess(false), 2000);
    } catch {
      setSlError("Failed to save configuration");
    } finally {
      setSlSaving(false);
    }
  };

  const handleTestShortLinks = async () => {
    setSlTesting(true);
    setSlTestResult(null);
    try {
      const res = await fetch("/api/short-links/test", { method: "POST" });
      const data = await res.json();
      setSlTestResult(data);
    } catch {
      setSlTestResult({ success: false, error: "Failed to connect" });
    } finally {
      setSlTesting(false);
    }
  };

  // Signatures
  const [sigs, setSigs] = useState<Signature[]>([]);
  const [sigsLoading, setSigsLoading] = useState(true);
  const [sigName, setSigName] = useState("");
  const [sigContent, setSigContent] = useState("");
  const [sigPosition, setSigPosition] = useState<"append" | "prepend">("append");
  const [sigIsDefault, setSigIsDefault] = useState(false);
  const [sigSaving, setSigSaving] = useState(false);
  const [sigError, setSigError] = useState("");
  const [sigEditingId, setSigEditingId] = useState<string | null>(null);

  const fetchSignatures = useCallback(() => {
    fetch("/api/signatures?limit=50")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.data) setSigs(data.data);
      })
      .catch(() => {})
      .finally(() => setSigsLoading(false));
  }, []);

  useEffect(() => { fetchSignatures(); }, [fetchSignatures]);

  const handleSaveSig = async () => {
    if (!sigName.trim() || !sigContent.trim()) {
      setSigError("Name and content are required.");
      return;
    }
    setSigSaving(true);
    setSigError("");
    const body = {
      name: sigName.trim(),
      content: sigContent.trim(),
      position: sigPosition,
      is_default: sigIsDefault,
    };
    try {
      const url = sigEditingId ? `/api/signatures/${sigEditingId}` : "/api/signatures";
      const res = await fetch(url, {
        method: sigEditingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setSigError(err?.error?.message || `Error ${res.status}`);
        return;
      }
      setSigName("");
      setSigContent("");
      setSigPosition("append");
      setSigIsDefault(false);
      setSigEditingId(null);
      fetchSignatures();
    } catch {
      setSigError("Network error");
    } finally {
      setSigSaving(false);
    }
  };

  const handleDeleteSig = async (id: string) => {
    const res = await fetch(`/api/signatures/${id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) fetchSignatures();
  };

  const handleSetDefaultSig = async (id: string) => {
    const res = await fetch(`/api/signatures/${id}/set-default`, { method: "POST" });
    if (res.ok) fetchSignatures();
  };

  const handleEditSig = (sig: Signature) => {
    setSigEditingId(sig.id);
    setSigName(sig.name);
    setSigContent(sig.content);
    setSigPosition(sig.position);
    setSigIsDefault(sig.is_default);
  };

  const handleCancelEditSig = () => {
    setSigEditingId(null);
    setSigName("");
    setSigContent("");
    setSigPosition("append");
    setSigIsDefault(false);
    setSigError("");
  };

  useEffect(() => {
    fetch("/api/notifications/preferences")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((data) => {
        setPrefs(data as NotificationPrefs);
      })
      .catch(() => setPrefsError(true))
      .finally(() => setPrefsLoading(false));
  }, []);

  const savePrefs = useCallback((updated: NotificationPrefs) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch("/api/notifications/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      }).catch(() => {});
    }, 500);
  }, []);

  const togglePref = (key: keyof NotificationPrefs, channel: "push" | "email") => {
    if (!prefs) return;

    // Prevent disabling email for always-on types
    const typeConfig = NOTIFICATION_TYPES.find((t) => t.key === key);
    if (typeConfig?.emailAlwaysOn && channel === "email") return;

    const updated = {
      ...prefs,
      [key]: {
        ...prefs[key],
        [channel]: !prefs[key][channel],
      },
    };
    setPrefs(updated);
    savePrefs(updated);
  };

  return (
    <motion.div
      className="space-y-6"
      variants={stagger}
      initial="hidden"
      animate="visible"
    >
      <motion.div variants={fadeUp}>
        <h1 className="text-lg font-medium">Settings</h1>
      </motion.div>

      {/* Organization Profile */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-border overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border bg-accent/10">
          <h2 className="text-[13px] font-medium flex items-center gap-2">
            <Building2 className="size-3.5" />
            Organization
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Manage your organization's profile
          </p>
        </div>

        {orgLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {/* Logo */}
            <div className="flex items-center gap-4">
              <div className="relative">
                <button
                  type="button"
                  className="group relative size-14 rounded-lg overflow-hidden focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
                  onClick={() => logoInputRef.current?.click()}
                  disabled={logoUploading}
                >
                  {orgLogo ? (
                    <img
                      src={orgLogo}
                      alt={orgName}
                      className="size-14 rounded-lg object-cover"
                    />
                  ) : (
                    <div className={cn(
                      "flex size-14 items-center justify-center rounded-lg text-xl font-bold text-white",
                      orgId ? getOrgColor(orgId) : "bg-muted",
                    )}>
                      {orgName?.charAt(0)?.toUpperCase() || "?"}
                    </div>
                  )}
                  <div className={cn(
                    "absolute inset-0 rounded-lg bg-black/50 flex items-center justify-center transition-opacity",
                    logoUploading ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}>
                    {logoUploading ? (
                      <Loader2 className="size-5 animate-spin text-white" />
                    ) : (
                      <Camera className="size-5 text-white" />
                    )}
                  </div>
                </button>
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  className="hidden"
                  onChange={handleLogoChange}
                />
              </div>
              <div>
                <p className="text-[13px] font-medium">{orgName || "Organization"}</p>
                <p className="text-[11px] text-muted-foreground">
                  JPEG, PNG, GIF, or WebP. Max 2MB.
                </p>
                {orgLogo && (
                  <button
                    type="button"
                    className="text-[11px] text-muted-foreground hover:text-foreground mt-0.5"
                    onClick={handleRemoveLogo}
                    disabled={logoUploading}
                  >
                    Remove logo
                  </button>
                )}
                {logoError && (
                  <p className="text-[11px] text-red-400 mt-0.5">{logoError}</p>
                )}
              </div>
            </div>

            {/* Name */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                Organization Name
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-ring"
                />
                <Button
                  size="sm"
                  className="h-9 text-xs"
                  onClick={handleUpdateOrgName}
                  disabled={orgNameSaving || !orgName.trim() || orgName === originalOrgName}
                >
                  {orgNameSaving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : orgNameSuccess ? (
                    "Saved!"
                  ) : (
                    "Save"
                  )}
                </Button>
              </div>
              {orgNameError && (
                <p className="text-xs text-red-400">{orgNameError}</p>
              )}
            </div>

            {/* Slug */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                URL Slug
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={orgSlug}
                  onChange={(e) => setOrgSlug(slugify(e.target.value))}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-ring font-mono"
                />
                <Button
                  size="sm"
                  className="h-9 text-xs"
                  onClick={handleUpdateOrgSlug}
                  disabled={orgSlugSaving || !orgSlug.trim() || orgSlug === originalOrgSlug}
                >
                  {orgSlugSaving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : orgSlugSuccess ? (
                    "Saved!"
                  ) : (
                    "Save"
                  )}
                </Button>
              </div>
              {orgSlug && orgSlug !== originalOrgSlug && (
                <p className="text-[11px] text-muted-foreground">
                  relayapi.dev/org/{orgSlug}
                </p>
              )}
              {orgSlugError && (
                <p className="text-xs text-red-400">{orgSlugError}</p>
              )}
            </div>
          </div>
        )}
      </motion.div>

      {/* Notifications */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-border overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border bg-accent/10">
          <h2 className="text-[13px] font-medium flex items-center gap-2">
            <Bell className="size-3.5" />
            Notifications
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Choose which notifications you want to receive
          </p>
        </div>

        {prefsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : prefsError ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <p className="text-[12px]">Failed to load notification preferences</p>
            <button
              onClick={() => {
                setPrefsError(false);
                setPrefsLoading(true);
                fetch("/api/notifications/preferences")
                  .then((r) => {
                    if (!r.ok) throw new Error();
                    return r.json();
                  })
                  .then((data) => setPrefs(data as NotificationPrefs))
                  .catch(() => setPrefsError(true))
                  .finally(() => setPrefsLoading(false));
              }}
              className="text-[12px] text-primary hover:underline mt-1"
            >
              Retry
            </button>
          </div>
        ) : prefs ? (
          <div className="divide-y divide-border">
            {/* Column headers */}
            <div className="flex items-center justify-end px-4 py-2 bg-accent/5">
              <div className="flex items-center gap-6">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider w-10 text-center">
                  In-App
                </span>
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider w-10 text-center">
                  Email
                </span>
              </div>
            </div>

            {NOTIFICATION_TYPES.map(({ key, label, description, emailAlwaysOn }) => (
              <div
                key={key}
                className="flex items-center justify-between px-4 py-3"
              >
                <div className="flex-1 min-w-0 mr-4">
                  <p className="text-[13px] font-medium">{label}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {description}
                  </p>
                </div>
                <div className="flex items-center gap-6">
                  <div className="w-10 flex justify-center">
                    <Toggle
                      enabled={prefs[key].push}
                      onToggle={() => togglePref(key, "push")}
                    />
                  </div>
                  <div className="w-10 flex justify-center">
                    <Toggle
                      enabled={prefs[key].email}
                      onToggle={() => togglePref(key, "email")}
                      disabled={emailAlwaysOn}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="px-4 py-2.5 bg-accent/5 border-t border-border">
          <p className="text-[11px] text-muted-foreground">
            Note: Critical account and security emails cannot be disabled.
          </p>
        </div>
      </motion.div>

      {/* Short Links */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-border overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border bg-accent/10">
          <h2 className="text-[13px] font-medium flex items-center gap-2">
            <Link2 className="size-3.5" />
            Short Links
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Automatically shorten URLs in your posts and track clicks
          </p>
        </div>

        {slLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {/* Mode */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                URL Shortening Mode
              </label>
              <div className="space-y-1.5">
                {(["always", "ask", "never"] as const).map((mode) => (
                  <label
                    key={mode}
                    className={cn(
                      "flex items-start gap-3 rounded-md border px-3 py-2.5 cursor-pointer transition-colors",
                      slMode === mode
                        ? "border-primary/50 bg-primary/5"
                        : "border-border hover:bg-accent/5"
                    )}
                  >
                    <input
                      type="radio"
                      name="sl-mode"
                      value={mode}
                      checked={slMode === mode}
                      onChange={() => setSlMode(mode)}
                      className="mt-0.5 accent-primary"
                    />
                    <div>
                      <p className="text-[13px] font-medium capitalize">{mode}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {mode === "always" && "Automatically shorten all URLs in posts"}
                        {mode === "ask" && "Show a toggle in the post dialog to shorten URLs"}
                        {mode === "never" && "Don't shorten URLs"}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Provider settings (hidden when mode is never) */}
            {slMode !== "never" && (
              <>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    Provider
                  </label>
                  <Select value={slProvider} onValueChange={(v) => { setSlProvider(v); setSlTestResult(null); }}>
                    <SelectTrigger size="sm" className="h-9 text-xs">
                      <SelectValue placeholder="Select a provider" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="relayapi">Built-in (no API key needed)</SelectItem>
                      <SelectItem value="dub">Dub.co</SelectItem>
                      <SelectItem value="short_io">Short.io</SelectItem>
                      <SelectItem value="bitly">Bitly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {slProvider !== "relayapi" && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    API Key
                  </label>
                  {slHasKey && !slEditingKey ? (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 rounded-md border border-border bg-accent/5 px-3 py-2 text-[13px] text-muted-foreground">
                        ••••••••••••••••
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-9 text-xs"
                        onClick={() => setSlEditingKey(true)}
                      >
                        Change
                      </Button>
                    </div>
                  ) : (
                    <input
                      type="password"
                      value={slApiKey}
                      onChange={(e) => { setSlApiKey(e.target.value); setSlTestResult(null); }}
                      placeholder="Enter your API key"
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-ring"
                    />
                  )}
                </div>
                )}

                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    Custom Domain{" "}
                    <span className="font-normal text-muted-foreground/60">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={slDomain}
                    onChange={(e) => setSlDomain(e.target.value)}
                    placeholder="e.g. link.mybrand.com"
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>

                {/* Test + Save */}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={handleTestShortLinks}
                    disabled={slTesting || !slProvider || (slProvider !== "relayapi" && !slHasKey && !slApiKey)}
                  >
                    {slTesting ? (
                      <Loader2 className="size-3 animate-spin mr-1" />
                    ) : null}
                    Test Connection
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 text-xs"
                    onClick={handleSaveShortLinks}
                    disabled={slSaving}
                  >
                    {slSaving ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : slSaveSuccess ? (
                      "Saved!"
                    ) : (
                      "Save"
                    )}
                  </Button>
                </div>

                {/* Test result */}
                {slTestResult && (
                  <div className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-xs",
                    slTestResult.success
                      ? "bg-emerald-500/10 text-emerald-400"
                      : "bg-red-500/10 text-red-400"
                  )}>
                    {slTestResult.success ? (
                      <Check className="size-3.5 shrink-0" />
                    ) : (
                      <X className="size-3.5 shrink-0" />
                    )}
                    <span>
                      {slTestResult.success
                        ? `Success! Shortened to: ${slTestResult.short_url}`
                        : `Failed: ${slTestResult.error}`}
                    </span>
                  </div>
                )}
              </>
            )}

            {slError && <p className="text-xs text-red-400">{slError}</p>}

            {/* Save button when mode is never (just save mode change) */}
            {slMode === "never" && (
              <Button
                size="sm"
                className="h-8 text-xs"
                onClick={handleSaveShortLinks}
                disabled={slSaving}
              >
                {slSaving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : slSaveSuccess ? (
                  "Saved!"
                ) : (
                  "Save"
                )}
              </Button>
            )}
          </div>
        )}

        <div className="px-4 py-2.5 bg-accent/5 border-t border-border">
          <p className="text-[11px] text-muted-foreground">
            Pro feature. Supports Dub.co, Short.io, and Bitly.
          </p>
        </div>
      </motion.div>

      {/* Signatures */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-border overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border bg-accent/10">
          <h2 className="text-[13px] font-medium flex items-center gap-2">
            <Pen className="size-3.5" />
            Signatures
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Auto-append or prepend text to new posts
          </p>
        </div>

        {sigsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {/* Existing signatures */}
            {sigs.length > 0 && (
              <div className="space-y-2">
                {sigs.map((sig) => (
                  <div
                    key={sig.id}
                    className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-[13px] font-medium truncate">{sig.name}</p>
                        {sig.is_default && (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                            <Star className="size-2.5" />
                            Default
                          </span>
                        )}
                        <span className="rounded-full bg-accent/40 px-1.5 py-0.5 text-[10px] font-medium text-foreground/50 capitalize">
                          {sig.position}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                        {sig.content}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {!sig.is_default && (
                        <button
                          onClick={() => handleSetDefaultSig(sig.id)}
                          className="rounded p-1 hover:bg-accent/50 transition-colors"
                          title="Set as default"
                        >
                          <Star className="size-3.5 text-foreground/40" />
                        </button>
                      )}
                      <button
                        onClick={() => handleEditSig(sig)}
                        className="rounded p-1 hover:bg-accent/50 transition-colors"
                        title="Edit"
                      >
                        <Pen className="size-3.5 text-foreground/40" />
                      </button>
                      <button
                        onClick={() => handleDeleteSig(sig.id)}
                        className="rounded p-1 hover:bg-accent/50 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="size-3.5 text-foreground/40" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Add/Edit form */}
            <div className="space-y-3 rounded-md border border-dashed border-border p-3">
              <p className="text-xs font-medium text-foreground/70">
                {sigEditingId ? "Edit Signature" : "Add Signature"}
              </p>
              <input
                type="text"
                value={sigName}
                onChange={(e) => setSigName(e.target.value)}
                placeholder="Signature name"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-ring"
              />
              <textarea
                value={sigContent}
                onChange={(e) => setSigContent(e.target.value)}
                placeholder="Signature text..."
                rows={3}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="flex items-center gap-4">
                <Select value={sigPosition} onValueChange={(v: "append" | "prepend") => setSigPosition(v)}>
                  <SelectTrigger size="sm" className="h-8 text-xs w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="append">Append</SelectItem>
                    <SelectItem value="prepend">Prepend</SelectItem>
                  </SelectContent>
                </Select>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={sigIsDefault}
                    onChange={(e) => setSigIsDefault(e.target.checked)}
                    className="accent-primary"
                  />
                  Set as default
                </label>
              </div>
              {sigError && <p className="text-xs text-red-400">{sigError}</p>}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={handleSaveSig}
                  disabled={sigSaving}
                >
                  {sigSaving ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Plus className="size-3" />
                  )}
                  {sigEditingId ? "Update" : "Add"}
                </Button>
                {sigEditingId && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={handleCancelEditSig}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="px-4 py-2.5 bg-accent/5 border-t border-border">
          <p className="text-[11px] text-muted-foreground">
            The default signature is automatically added to new posts. API users can skip it with{" "}
            <code className="text-[10px] bg-accent/40 px-1 py-0.5 rounded">skip_signature: true</code>.
          </p>
        </div>
      </motion.div>

      {/* Organization Settings */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-border overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border bg-accent/10">
          <h2 className="text-[13px] font-medium flex items-center gap-2">
            <Shield className="size-3.5" />
            Organization Settings
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Configure organization-wide API behavior
          </p>
        </div>

        {orgSettingsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="divide-y divide-border">
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex-1 min-w-0 mr-4">
                <p className="text-[13px] font-medium">
                  Require Workspace ID
                </p>
                <p className="text-[11px] text-muted-foreground">
                  When enabled, all API create requests must include a{" "}
                  <code className="text-[10px] bg-accent/40 px-1 py-0.5 rounded">
                    workspace_id
                  </code>
                  . Useful for multi-tenant deployments to enforce customer isolation.
                </p>
              </div>
              <Toggle
                enabled={requireWorkspaceId}
                onToggle={toggleRequireWorkspaceId}
                disabled={orgSettingsSaving}
              />
            </div>
          </div>
        )}

        <div className="px-4 py-2.5 bg-accent/5 border-t border-border">
          <p className="text-[11px] text-muted-foreground">
            Changes take effect immediately for all API keys in this organization.
          </p>
        </div>
      </motion.div>

      {/* Danger Zone */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-red-500/30 overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-red-500/30 bg-red-500/5">
          <h2 className="text-[13px] font-medium text-red-400 flex items-center gap-2">
            <Trash2 className="size-3.5" />
            Danger Zone
          </h2>
        </div>
        <div className="p-4">
          {!deleteConfirmOpen ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] font-medium">Delete Organization</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Permanently delete this organization, all its API keys, connections, and data
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs text-red-400 border-red-500/30 hover:bg-red-500/10 hover:text-red-400"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                Delete Organization
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                This will permanently delete <span className="font-medium text-foreground">{orgName}</span> and all associated data including API keys, connections, posts, webhooks, and team members. This action cannot be undone.
              </p>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Type <span className="font-mono text-foreground">{orgName}</span> to confirm
                </label>
                <input
                  type="text"
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder={orgName}
                  className="w-full rounded-md border border-red-500/30 bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-red-500/50 placeholder:text-muted-foreground/50"
                />
              </div>
              {deleteError && (
                <p className="text-xs text-red-400">{deleteError}</p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => {
                    setDeleteConfirmOpen(false);
                    setDeleteConfirmText("");
                    setDeleteError("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-xs bg-red-600 hover:bg-red-700 text-white"
                  onClick={handleDeleteOrg}
                  disabled={deleteLoading || deleteConfirmText !== orgName}
                >
                  {deleteLoading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    "Delete Organization"
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      </motion.div>

    </motion.div>
  );
}
