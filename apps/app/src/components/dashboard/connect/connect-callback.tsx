import { useState, useEffect, useRef } from "react";
import { Loader2, CheckCircle2, Circle, AlertCircle, ArrowLeft, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  platformColors,
  platformLabels,
  platformAvatars,
  secondarySelectionPlatforms,
} from "@/lib/platform-maps";
import { WorkspaceSearchCombobox } from "@/components/dashboard/workspace-search-combobox";

type Step =
  | { type: "exchanging" }
  | { type: "secondary"; items: SecondaryItem[]; connectToken: string }
  | { type: "assign-workspace"; accountId: string }
  | { type: "success" }
  | { type: "error"; message: string };

interface SecondaryItem {
  id: string;
  name: string;
  subtitle?: string | null;
  imageUrl?: string | null;
}

interface ConnectCallbackProps {
  platform: string;
  code: string;
  state: string;
  error: string;
  // Params from server-side OAuth callback redirect
  serverStatus?: string;
  serverAccountId?: string;
  serverErrorCode?: string;
  serverErrorMessage?: string;
  serverErrorDescription?: string;
}

const SECONDARY_CONFIG: Record<string, { endpoint: string; listKey: string; idField: string; label: string }> = {
  facebook: { endpoint: "connect/facebook/pages", listKey: "pages", idField: "page_id", label: "Select a Page" },
  linkedin: { endpoint: "connect/linkedin/organizations", listKey: "organizations", idField: "organization_urn", label: "Select a Profile" },
  pinterest: { endpoint: "connect/pinterest/boards", listKey: "boards", idField: "board_id", label: "Select a Board" },
  googlebusiness: { endpoint: "connect/googlebusiness/locations", listKey: "locations", idField: "location_id", label: "Select a Location" },
  snapchat: { endpoint: "connect/snapchat/profiles", listKey: "profiles", idField: "profile_id", label: "Select a Profile" },
};

function goToSuccess(setStep: (s: Step) => void) {
  setStep({ type: "success" });
  setTimeout(() => {
    window.location.href = `/app/connections?tab=accounts&t=${Date.now()}`;
  }, 1500);
}

export function ConnectCallback({
  platform, code, state, error: oauthError,
  serverStatus, serverAccountId, serverErrorCode, serverErrorMessage, serverErrorDescription,
}: ConnectCallbackProps) {
  // Determine initial step based on server-side callback params or legacy flow
  const getInitialStep = (): Step => {
    // Handle OAuth errors (from provider or server-side callback)
    if (oauthError) {
      return { type: "error", message: oauthError === "access_denied" ? "Authorization was denied." : oauthError };
    }
    if (serverStatus === "error") {
      return { type: "error", message: serverErrorMessage || serverErrorDescription || serverErrorCode || "Connection failed" };
    }
    // Server-side callback completed successfully — go straight to group assignment
    if (serverStatus === "success" && serverAccountId) {
      return { type: "assign-workspace", accountId: serverAccountId };
    }
    // Server-side callback needs secondary selection (Facebook pages, LinkedIn orgs, etc.)
    if (serverStatus === "pending_selection") {
      return { type: "exchanging" }; // Will load secondary items in useEffect
    }
    // Legacy flow: code present, need to exchange client-side
    return { type: "exchanging" };
  };

  const [step, setStep] = useState<Step>(getInitialStep);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [linkedinPersonal, setLinkedinPersonal] = useState<{ name: string; urn: string } | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [assigningGroup, setAssigningGroup] = useState(false);
  const exchanged = useRef(false);

  // Extract account ID from API responses
  const getAccountId = (data: any): string | null => {
    // Direct account response
    if (data?.account?.id) return data.account.id;
    // The response might be the account itself
    if (data?.id && data.id !== "pending") return data.id;
    return null;
  };

  // Load secondary selection items (for server-side callback with pending_selection)
  const loadSecondaryItems = async () => {
    const config = SECONDARY_CONFIG[platform];
    if (!config) return;

    try {
      const listRes = await fetch(`/api/${config.endpoint}`);
      if (listRes.ok) {
        const listData = await listRes.json();
        const rawItems = listData[config.listKey] || [];
        const items: SecondaryItem[] = rawItems.map((item: any) => ({
          id: item.id || item.urn || item.profile_id,
          name: item.name || item.display_name || "Unknown",
          subtitle: item.category || item.vanity_name || item.description || item.address || item.username || null,
          imageUrl: item.picture_url || item.logo_url || item.profile_image_url || null,
        }));

        if (platform === "linkedin" && listData.personal_profile) {
          setLinkedinPersonal(listData.personal_profile);
        }

        const connectToken = listData.connect_token || "";
        setStep({ type: "secondary", items, connectToken });
      } else {
        setStep({ type: "error", message: "Failed to load selection options" });
      }
    } catch {
      setStep({ type: "error", message: "Failed to load selection options" });
    }
  };

  useEffect(() => {
    if (exchanged.current) return;

    // Server-side callback already handled — load secondary items if needed
    if (serverStatus === "pending_selection") {
      exchanged.current = true;
      loadSecondaryItems();
      return;
    }

    // Server-side callback already handled success/error — nothing to do
    if (serverStatus) return;

    // Legacy client-side exchange flow (code present, no serverStatus)
    if (oauthError || !code) return;
    exchanged.current = true;

    const redirectUrl = `${window.location.origin}/app/connect/callback/${platform}`;

    (async () => {
      try {
        const res = await fetch(`/api/connect/${platform}/callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, redirect_url: redirectUrl }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => null);
          setStep({ type: "error", message: err?.error?.message || `Connection failed (${res.status})` });
          return;
        }

        const responseData = await res.json();

        if (secondarySelectionPlatforms.has(platform)) {
          const config = SECONDARY_CONFIG[platform];
          if (config) {
            const listRes = await fetch(`/api/${config.endpoint}`);
            if (listRes.ok) {
              const listData = await listRes.json();
              const rawItems = listData[config.listKey] || [];
              const items: SecondaryItem[] = rawItems.map((item: any) => ({
                id: item.id || item.urn || item.profile_id,
                name: item.name || item.display_name || "Unknown",
                subtitle: item.category || item.vanity_name || item.description || item.address || item.username || null,
                imageUrl: item.picture_url || item.logo_url || item.profile_image_url || null,
              }));

              if (platform === "linkedin" && listData.personal_profile) {
                setLinkedinPersonal(listData.personal_profile);
              }

              const connectToken = listData.connect_token || "";
              setStep({ type: "secondary", items, connectToken });
              return;
            }
          }
        }

        // Non-secondary-selection platform: go to group assignment
        const accountId = getAccountId(responseData);
        if (accountId) {
          setStep({ type: "assign-workspace", accountId });
        } else {
          goToSuccess(setStep);
        }
      } catch (err) {
        setStep({ type: "error", message: err instanceof Error ? err.message : "Connection failed" });
      }
    })();
  }, [platform, code, oauthError, serverStatus]);

  const handleSecondarySelect = async () => {
    if (step.type !== "secondary" || !selectedId) return;
    const config = SECONDARY_CONFIG[platform];
    if (!config) return;

    setSubmitting(true);
    try {
      let body: Record<string, string>;
      if (platform === "linkedin") {
        const isPersonal = selectedId === linkedinPersonal?.urn;
        body = {
          connect_token: step.connectToken,
          account_type: isPersonal ? "personal" : "organization",
          ...(isPersonal ? {} : { organization_urn: selectedId }),
        };
      } else {
        body = {
          connect_token: step.connectToken,
          [config.idField]: selectedId,
        };
      }

      const res = await fetch(`/api/${config.endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setStep({ type: "error", message: err?.error?.message || "Selection failed" });
        return;
      }

      const responseData = await res.json();
      const accountId = getAccountId(responseData);
      if (accountId) {
        setStep({ type: "assign-workspace", accountId });
      } else {
        goToSuccess(setStep);
      }
    } catch (err) {
      setStep({ type: "error", message: err instanceof Error ? err.message : "Selection failed" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleAssignGroup = async () => {
    if (step.type !== "assign-workspace" || !workspaceId) return;
    setAssigningGroup(true);
    try {
      await fetch(`/api/accounts/${step.accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
    } catch {
      // ignore — account is connected regardless
    }
    setAssigningGroup(false);
    goToSuccess(setStep);
  };

  const handleSkipGroup = () => {
    goToSuccess(setStep);
  };

  const platformLabel = platformLabels[platform] || platform;
  const avatar = platformAvatars[platform] || platform.slice(0, 2).toUpperCase();
  const color = platformColors[platform] || "bg-neutral-700";

  return (
    <div className="w-full max-w-md">
      <div className="rounded-lg border border-border bg-card p-8">
        <div className="flex flex-col items-center gap-4">
          <div className={cn("flex size-12 items-center justify-center rounded-lg text-sm font-bold text-white", color)}>
            {avatar}
          </div>

          {step.type === "exchanging" && (
            <>
              <div className="text-center">
                <h2 className="text-base font-medium">Connecting {platformLabel}</h2>
                <p className="mt-1 text-sm text-muted-foreground">Completing authorization...</p>
              </div>
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </>
          )}

          {step.type === "success" && (
            <>
              <div className="text-center">
                <h2 className="text-base font-medium">{platformLabel} connected</h2>
                <p className="mt-1 text-sm text-muted-foreground">Redirecting to your accounts...</p>
              </div>
              <CheckCircle2 className="size-6 text-emerald-500" />
            </>
          )}

          {step.type === "error" && (
            <>
              <div className="text-center">
                <h2 className="text-base font-medium">Connection failed</h2>
                <p className="mt-1 text-sm text-muted-foreground">{step.message}</p>
              </div>
              <AlertCircle className="size-6 text-destructive" />
              <a href="/app/connections?tab=connect">
                <Button variant="outline" size="sm" className="gap-1.5">
                  <ArrowLeft className="size-3.5" />
                  Back to Connect
                </Button>
              </a>
            </>
          )}

          {step.type === "assign-workspace" && (
            <div className="w-full">
              <div className="text-center mb-4">
                <h2 className="text-base font-medium">Add to workspace</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Optionally assign this account to a workspace
                </p>
              </div>

              <WorkspaceSearchCombobox
                value={workspaceId}
                onSelect={(id) => setWorkspaceId(id)}
                allowCreate
                placeholder="Search workspaces..."
              />

              <div className="mt-4 flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={handleSkipGroup}
                >
                  Skip
                </Button>
                <Button
                  size="sm"
                  className="flex-1"
                  disabled={!workspaceId || assigningGroup}
                  onClick={handleAssignGroup}
                >
                  {assigningGroup ? <Loader2 className="size-3.5 animate-spin" /> : "Add to Workspace"}
                </Button>
              </div>
            </div>
          )}

          {step.type === "secondary" && (
            <div className="w-full">
              <div className="text-center mb-4">
                <h2 className="text-base font-medium">{SECONDARY_CONFIG[platform]?.label}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Choose which {platform === "facebook" ? "page" : platform === "pinterest" ? "board" : platform === "googlebusiness" ? "location" : "profile"} to connect
                </p>
              </div>

              <div className="max-h-64 overflow-y-auto space-y-1.5">
                {platform === "linkedin" && linkedinPersonal && (
                  <button
                    className={cn(
                      "w-full flex items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                      selectedId === linkedinPersonal.urn
                        ? "border-foreground bg-accent/40"
                        : "border-border hover:bg-accent/20",
                    )}
                    onClick={() => setSelectedId(linkedinPersonal.urn)}
                  >
                    <div className="size-8 rounded-full bg-blue-700 flex items-center justify-center text-white text-xs font-bold shrink-0">
                      {linkedinPersonal.name.charAt(0)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{linkedinPersonal.name}</p>
                      <p className="text-xs text-muted-foreground">Personal profile</p>
                    </div>
                    {selectedId === linkedinPersonal.urn ? (
                      <CheckCircle2 className="size-5 text-foreground shrink-0" />
                    ) : (
                      <Circle className="size-5 text-muted-foreground/40 shrink-0" />
                    )}
                  </button>
                )}

                {step.items.map((item) => (
                  <button
                    key={item.id}
                    className={cn(
                      "w-full flex items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                      selectedId === item.id
                        ? "border-foreground bg-accent/40"
                        : "border-border hover:bg-accent/20",
                    )}
                    onClick={() => setSelectedId(item.id)}
                  >
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt="" className="size-8 rounded-full object-cover shrink-0" />
                    ) : (
                      <div className={cn("size-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0", color)}>
                        {item.name.charAt(0)}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{item.name}</p>
                      {item.subtitle && (
                        <p className="text-xs text-muted-foreground truncate">{item.subtitle}</p>
                      )}
                    </div>
                    {selectedId === item.id ? (
                      <CheckCircle2 className="size-5 text-foreground shrink-0" />
                    ) : (
                      <Circle className="size-5 text-muted-foreground/40 shrink-0" />
                    )}
                  </button>
                ))}

                {step.items.length === 0 && !linkedinPersonal && (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    No options available. Try reconnecting.
                  </div>
                )}
              </div>

              <div className="mt-4 flex gap-2">
                <a href="/app/connections?tab=connect" className="flex-1">
                  <Button variant="outline" size="sm" className="w-full">
                    Cancel
                  </Button>
                </a>
                <Button
                  size="sm"
                  className="flex-1"
                  disabled={!selectedId || submitting}
                  onClick={handleSecondarySelect}
                >
                  {submitting ? <Loader2 className="size-3.5 animate-spin" /> : "Connect"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
