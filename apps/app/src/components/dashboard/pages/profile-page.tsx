import { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "motion/react";
import {
  User,
  Mail,
  Lock,
  Monitor,
  Smartphone,
  Globe,
  Trash2,
  LogOut,
  Shield,
  Link2,
  Unlink,
  Loader2,
  Camera,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { authClient, useSession } from "@/lib/auth-client";

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

interface SessionInfo {
  id: string;
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

interface LinkedAccount {
  id: string;
  providerId: string;
  accountId: string;
}

export function ProfilePage() {
  const { data: session, isPending: sessionLoading } = useSession();
  const user = session?.user;

  const [name, setName] = useState("");
  const [nameLoading, setNameLoading] = useState(false);
  const [nameSuccess, setNameSuccess] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);

  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [timezone, setTimezone] = useState(() =>
    typeof window !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC"
  );
  const [timezoneLoading, setTimezoneLoading] = useState(true);
  const timezoneTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const allTimezones = typeof Intl !== "undefined" && Intl.supportedValuesOf
    ? Intl.supportedValuesOf("timeZone")
    : [];

  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    if (user?.name) setName(user.name);
  }, [user?.name]);

  useEffect(() => {
    loadSessions();
    loadAccounts();
    fetch("/api/user-preferences")
      .then((r) => r.json())
      .then((data) => {
        if (data.timezone && data.timezone !== "UTC") {
          setTimezone(data.timezone);
        } else {
          // Auto-detect from browser and save
          const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          setTimezone(browserTz);
          saveTimezone(browserTz);
        }
      })
      .catch(() => {})
      .finally(() => setTimezoneLoading(false));
  }, []);

  const saveTimezone = useCallback((tz: string) => {
    clearTimeout(timezoneTimer.current);
    timezoneTimer.current = setTimeout(() => {
      fetch("/api/user-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: tz }),
      }).catch(() => {});
    }, 500);
  }, []);

  const loadSessions = async () => {
    try {
      const res = await authClient.listSessions();
      if (res.data) setSessions(res.data as SessionInfo[]);
    } catch {
      // ignore
    } finally {
      setSessionsLoading(false);
    }
  };

  const loadAccounts = async () => {
    try {
      const res = await authClient.listAccounts();
      if (res.data) setAccounts(res.data as LinkedAccount[]);
    } catch {
      // ignore
    } finally {
      setAccountsLoading(false);
    }
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      setAvatarError("File must be under 2MB");
      return;
    }
    const validTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (!validTypes.includes(file.type)) {
      setAvatarError("Only JPEG, PNG, GIF, or WebP allowed");
      return;
    }

    setAvatarUploading(true);
    setAvatarError("");
    try {
      const res = await fetch("/api/profile/avatar", {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || "Upload failed");
      }
      const { url } = await res.json();
      const updateRes = await authClient.updateUser({ image: `${url}?t=${Date.now()}` });
      if (updateRes.error) throw new Error(updateRes.error.message || "Failed to update avatar");
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setAvatarUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRemoveAvatar = async () => {
    setAvatarUploading(true);
    setAvatarError("");
    try {
      await fetch("/api/profile/avatar", { method: "DELETE" });
      const updateRes = await authClient.updateUser({ image: null as unknown as string });
      if (updateRes.error) throw new Error(updateRes.error.message || "Failed to remove avatar");
    } catch {
      setAvatarError("Failed to remove photo");
    } finally {
      setAvatarUploading(false);
    }
  };

  const [nameError, setNameError] = useState("");

  const handleUpdateName = async () => {
    if (!name.trim() || name === user?.name) return;
    setNameLoading(true);
    setNameSuccess(false);
    setNameError("");
    try {
      const res = await authClient.updateUser({ name: name.trim() });
      if (res.error) {
        setNameError(res.error.message || "Failed to update name");
      } else {
        setNameSuccess(true);
        setTimeout(() => setNameSuccess(false), 2000);
      }
    } catch {
      setNameError("Failed to update name");
    } finally {
      setNameLoading(false);
    }
  };

  const handleChangePassword = async () => {
    setPasswordError("");
    setPasswordSuccess(false);
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords don't match");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError("Password must be at least 8 characters");
      return;
    }
    setPasswordLoading(true);
    try {
      const res = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: false,
      });
      if (res.error) {
        setPasswordError(res.error.message || "Failed to change password");
      } else {
        setPasswordSuccess(true);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setTimeout(() => setPasswordSuccess(false), 2000);
      }
    } catch {
      setPasswordError("Failed to change password");
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleRevokeSession = async (token: string) => {
    try {
      await authClient.revokeSession({ token });
      setSessions((prev) => prev.filter((s) => s.token !== token));
    } catch {
      // ignore
    }
  };

  const handleRevokeOtherSessions = async () => {
    try {
      const res = await authClient.revokeOtherSessions();
      if (res.error) {
        console.error("Failed to revoke sessions:", res.error.message);
      }
      await loadSessions();
    } catch {
      // ignore
    }
  };

  const handleLinkGoogle = async () => {
    try {
      await authClient.linkSocial({ provider: "google", callbackURL: "/app/profile" });
    } catch {
      // ignore
    }
  };

  const handleUnlinkAccount = async (providerId: string) => {
    try {
      await authClient.unlinkAccount({ providerId });
      setAccounts((prev) => prev.filter((a) => a.providerId !== providerId));
    } catch {
      // ignore
    }
  };

  const handleDeleteAccount = async () => {
    if (!deletePassword) return;
    setDeleteLoading(true);
    setDeleteError("");
    try {
      const res = await authClient.deleteUser({ password: deletePassword });
      if (res.error) {
        setDeleteError(res.error.message || "Failed to delete account");
      } else {
        window.location.href = "/login";
      }
    } catch {
      setDeleteError("Failed to delete account. Check your password and try again.");
    } finally {
      setDeleteLoading(false);
    }
  };

  const parseUserAgent = (ua?: string | null) => {
    if (!ua) return { device: "Unknown", browser: "Unknown" };
    const isMobile = /mobile|android|iphone/i.test(ua);
    let browser = "Unknown";
    if (/chrome/i.test(ua) && !/edge/i.test(ua)) browser = "Chrome";
    else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = "Safari";
    else if (/firefox/i.test(ua)) browser = "Firefox";
    else if (/edge/i.test(ua)) browser = "Edge";
    return { device: isMobile ? "Mobile" : "Desktop", browser };
  };

  const userInitials = user?.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "?";

  if (sessionLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <motion.div
      className="space-y-6"
      variants={stagger}
      initial={false}
      animate="visible"
    >
      <motion.div variants={fadeUp}>
        <h1 className="text-lg font-medium">Profile</h1>
      </motion.div>

      {/* Personal Information */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-border overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border bg-accent/10">
          <h2 className="text-[13px] font-medium">Personal Information</h2>
        </div>
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-4">
            <div className="relative">
              <button
                type="button"
                className="group relative size-14 rounded-full overflow-hidden focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
                onClick={() => fileInputRef.current?.click()}
                disabled={avatarUploading}
              >
                {user?.image ? (
                  <img
                    src={user.image}
                    alt={user.name}
                    className="size-14 rounded-full object-cover"
                  />
                ) : (
                  <div className="flex size-14 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground">
                    {userInitials}
                  </div>
                )}
                <div className={cn(
                  "absolute inset-0 rounded-full bg-black/50 flex items-center justify-center transition-opacity",
                  avatarUploading ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}>
                  {avatarUploading ? (
                    <Loader2 className="size-5 animate-spin text-white" />
                  ) : (
                    <Camera className="size-5 text-white" />
                  )}
                </div>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                className="hidden"
                onChange={handleAvatarChange}
              />
            </div>
            <div>
              <p className="text-[13px] font-medium">{user?.name || "User"}</p>
              <p className="text-xs text-muted-foreground">{user?.email}</p>
              {user?.image && (
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground hover:text-foreground mt-0.5"
                  onClick={handleRemoveAvatar}
                  disabled={avatarUploading}
                >
                  Remove photo
                </button>
              )}
              {avatarError && (
                <p className="text-[11px] text-red-400 mt-0.5">{avatarError}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Display Name
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 pl-9 text-[13px] outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              <Button
                size="sm"
                className="h-9 text-xs"
                onClick={handleUpdateName}
                disabled={nameLoading || !name.trim() || name === user?.name}
              >
                {nameLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : nameSuccess ? (
                  "Saved!"
                ) : (
                  "Save"
                )}
              </Button>
            </div>
            {nameError && (
              <p className="text-xs text-red-400">{nameError}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Email Address
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input
                type="email"
                value={user?.email || ""}
                disabled
                className="w-full rounded-md border border-border bg-accent/20 px-3 py-2 pl-9 text-[13px] text-muted-foreground cursor-not-allowed"
              />
            </div>
          </div>
        </div>
      </motion.div>

      {/* Timezone */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-border overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border bg-accent/10">
          <h2 className="text-[13px] font-medium flex items-center gap-2">
            <Globe className="size-3.5" />
            Timezone
          </h2>
        </div>
        <div className="p-4">
          <div className="space-y-2 max-w-xs">
            <label className="text-xs font-medium text-muted-foreground">
              Timezone
            </label>
            <select
              value={timezone}
              onChange={(e) => {
                setTimezone(e.target.value);
                saveTimezone(e.target.value);
              }}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-ring"
            >
              {allTimezones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
        </div>
      </motion.div>

      {/* Change Password */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-border overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border bg-accent/10">
          <h2 className="text-[13px] font-medium flex items-center gap-2">
            <Lock className="size-3.5" />
            Change Password
          </h2>
        </div>
        <div className="p-4 space-y-3">
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Current Password
            </label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter current password"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                New Password
              </label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                Confirm Password
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
              />
            </div>
          </div>
          {passwordError && (
            <p className="text-xs text-red-400">{passwordError}</p>
          )}
          {passwordSuccess && (
            <p className="text-xs text-emerald-400">
              Password changed successfully
            </p>
          )}
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={handleChangePassword}
            disabled={
              passwordLoading || !currentPassword || !newPassword || !confirmPassword
            }
          >
            {passwordLoading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              "Update Password"
            )}
          </Button>
        </div>
      </motion.div>

      {/* Connected Accounts */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-border overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border bg-accent/10">
          <h2 className="text-[13px] font-medium flex items-center gap-2">
            <Link2 className="size-3.5" />
            Connected Accounts
          </h2>
        </div>
        <div className="p-4 space-y-3">
          {accountsLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-md border border-border px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="flex size-8 items-center justify-center rounded-full bg-accent/40">
                  <Globe className="size-4 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-[13px] font-medium">Google</p>
                  <p className="text-[11px] text-muted-foreground">
                    {accounts.find((a) => a.providerId === "google")
                      ? "Connected"
                      : "Not connected"}
                  </p>
                </div>
              </div>
              {accounts.find((a) => a.providerId === "google") ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5"
                  onClick={() => handleUnlinkAccount("google")}
                >
                  <Unlink className="size-3" />
                  Disconnect
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5"
                  onClick={handleLinkGoogle}
                >
                  <Link2 className="size-3" />
                  Connect
                </Button>
              )}
            </div>
          )}
        </div>
      </motion.div>

      {/* Active Sessions */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-border overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border bg-accent/10 flex items-center justify-between">
          <h2 className="text-[13px] font-medium flex items-center gap-2">
            <Shield className="size-3.5" />
            Active Sessions
          </h2>
          {sessions.length > 1 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5"
              onClick={handleRevokeOtherSessions}
            >
              <LogOut className="size-3" />
              Revoke all others
            </Button>
          )}
        </div>
        <div className="divide-y divide-border">
          {sessionsLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-xs text-muted-foreground">No active sessions</p>
            </div>
          ) : (
            sessions.map((s) => {
              const { device, browser } = parseUserAgent(s.userAgent);
              const isCurrent = s.token === session?.session?.token;
              const DeviceIcon = device === "Mobile" ? Smartphone : Monitor;
              return (
                <div
                  key={s.id}
                  className="flex items-center justify-between px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <DeviceIcon className="size-4 text-muted-foreground shrink-0" />
                    <div>
                      <p className="text-[13px] font-medium flex items-center gap-2">
                        {browser} on {device}
                        {isCurrent && (
                          <span className="text-[11px] text-emerald-400 font-normal">
                            Current
                          </span>
                        )}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {s.ipAddress || "Unknown IP"} · Last active{" "}
                        {new Date(s.updatedAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  {!isCurrent && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => handleRevokeSession(s.token)}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              );
            })
          )}
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
                <p className="text-[13px] font-medium">Delete Account</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Permanently delete your account and all associated data
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs text-red-400 border-red-500/30 hover:bg-red-500/10 hover:text-red-400"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                Delete Account
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Enter your password to confirm account deletion. This action is
                irreversible.
              </p>
              <input
                type="password"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                placeholder="Enter your password"
                className="w-full rounded-md border border-red-500/30 bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-red-500/50 placeholder:text-muted-foreground/50"
              />
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
                    setDeletePassword("");
                    setDeleteError("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-xs bg-red-600 hover:bg-red-700 text-white"
                  onClick={handleDeleteAccount}
                  disabled={deleteLoading || !deletePassword}
                >
                  {deleteLoading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    "Confirm Delete"
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
