import { useEffect, useState } from "react";
import { ArrowLeft, Loader2, MessageSquare, MessageCircle, UserPlus, Reply, Gift, Send } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AccountSearchCombobox } from "@/components/dashboard/account-search-combobox";
import { PostSearchCombobox } from "@/components/dashboard/post-search-combobox";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}

type TemplateId =
  | "comment-to-dm"
  | "welcome-dm"
  | "keyword-reply"
  | "follow-to-dm"
  | "story-reply"
  | "giveaway";

interface TemplateMeta {
  id: TemplateId;
  name: string;
  description: string;
  icon: typeof MessageSquare;
  supportedPlatforms: string[];
}

const TEMPLATES: TemplateMeta[] = [
  {
    id: "comment-to-dm",
    name: "Comment to DM",
    description: "Reply to Instagram comments with a DM to the commenter",
    icon: MessageSquare,
    supportedPlatforms: ["instagram"],
  },
  {
    id: "welcome-dm",
    name: "Welcome DM",
    description: "Greet a contact the first time they message you",
    icon: Send,
    supportedPlatforms: ["instagram", "facebook", "whatsapp"],
  },
  {
    id: "keyword-reply",
    name: "Keyword Reply",
    description: "Auto-reply when an inbound DM matches a keyword",
    icon: Reply,
    supportedPlatforms: [
      "instagram",
      "facebook",
      "whatsapp",
      "telegram",
      "twitter",
      "reddit",
    ],
  },
  {
    id: "follow-to-dm",
    name: "Follow to DM",
    description: "DM new followers (manual enrollment for IG)",
    icon: UserPlus,
    supportedPlatforms: ["instagram"],
  },
  {
    id: "story-reply",
    name: "Story Reply",
    description: "Respond when someone replies to an Instagram story",
    icon: MessageCircle,
    supportedPlatforms: ["instagram"],
  },
  {
    id: "giveaway",
    name: "Giveaway",
    description: "Tag and DM users who enter a giveaway via comment",
    icon: Gift,
    supportedPlatforms: ["instagram", "facebook"],
  },
];

type FormState = {
  name: string;
  account_id: string;
  account_platform?: string;
  post_id?: string;
  keywords?: string;
  match_mode?: "contains" | "exact";
  dm_message?: string;
  public_reply?: string;
  once_per_user?: boolean;
  welcome_message?: string;
  reply_message?: string;
  entry_keywords?: string;
  entry_tag?: string;
  confirmation_dm?: string;
};

const initialForm: FormState = {
  name: "",
  account_id: "",
  match_mode: "contains",
  once_per_user: true,
  entry_tag: "giveaway_entry",
};

export function AutomationTemplatePickerDialog({ open, onOpenChange, onCreated }: Props) {
  const [selected, setSelected] = useState<TemplateId | null>(null);
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTemplate = selected ? TEMPLATES.find((t) => t.id === selected) : null;
  const supportedPlatforms = selectedTemplate?.supportedPlatforms ?? [];

  useEffect(() => {
    if (!open) {
      setSelected(null);
      setForm(initialForm);
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const buildBody = (): Record<string, unknown> => {
    const base = {
      name: form.name.trim(),
      account_id: form.account_id,
    };
    switch (selected) {
      case "comment-to-dm":
        return {
          ...base,
          post_id: form.post_id?.trim() || null,
          keywords: (form.keywords ?? "").split(",").map((s) => s.trim()).filter(Boolean),
          match_mode: form.match_mode ?? "contains",
          dm_message: form.dm_message ?? "",
          ...(form.public_reply?.trim() ? { public_reply: form.public_reply.trim() } : {}),
          once_per_user: form.once_per_user ?? true,
        };
      case "welcome-dm":
        return {
          ...base,
          channel: form.account_platform ?? "instagram",
          welcome_message: form.welcome_message ?? "",
        };
      case "keyword-reply":
        return {
          ...base,
          channel: form.account_platform ?? "instagram",
          keywords: (form.keywords ?? "").split(",").map((s) => s.trim()).filter(Boolean),
          match_mode: form.match_mode ?? "contains",
          reply_message: form.reply_message ?? "",
        };
      case "follow-to-dm":
        return { ...base, welcome_message: form.welcome_message ?? "" };
      case "story-reply":
        return { ...base, dm_message: form.dm_message ?? "" };
      case "giveaway":
        return {
          ...base,
          channel: form.account_platform ?? "instagram",
          ...(form.post_id?.trim() ? { post_id: form.post_id.trim() } : {}),
          entry_keywords: (form.entry_keywords ?? "").split(",").map((s) => s.trim()).filter(Boolean),
          entry_tag: form.entry_tag ?? "giveaway_entry",
          confirmation_dm: form.confirmation_dm ?? "",
        };
      default:
        return base;
    }
  };

  const validateForm = (): string | null => {
    if (!form.name.trim()) return "Name is required.";
    if (!form.account_id) return "Please select an account.";
    const keywords = (form.keywords ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const entryKeywords = (form.entry_keywords ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    switch (selected) {
      case "comment-to-dm":
        if (keywords.length === 0)
          return "Add at least one keyword (comma-separated).";
        if (!form.dm_message?.trim()) return "DM message is required.";
        return null;
      case "welcome-dm":
        if (!form.welcome_message?.trim())
          return "Welcome message is required.";
        return null;
      case "keyword-reply":
        if (keywords.length === 0)
          return "Add at least one keyword (comma-separated).";
        if (!form.reply_message?.trim()) return "Reply message is required.";
        return null;
      case "follow-to-dm":
        if (!form.welcome_message?.trim())
          return "Welcome message is required.";
        return null;
      case "story-reply":
        if (!form.dm_message?.trim()) return "DM message is required.";
        return null;
      case "giveaway":
        if (entryKeywords.length === 0)
          return "Add at least one entry keyword (comma-separated).";
        if (!form.entry_tag?.trim()) return "Entry tag is required.";
        if (!form.confirmation_dm?.trim())
          return "Confirmation DM is required.";
        return null;
      default:
        return null;
    }
  };

  const submit = async () => {
    if (!selected) return;
    const problem = validateForm();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/automations/templates/${selected}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(
          body?.error?.message ??
            `Request failed (${res.status}). Check the form and try again.`,
        );
        return;
      }
      const created = (await res.json().catch(() => null)) as { id?: string } | null;
      onCreated();
      onOpenChange(false);
      if (created?.id) {
        window.location.href = `/app/automation/${created.id}`;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {selected && (
              <button
                onClick={() => {
                  setSelected(null);
                  setForm((f) => ({ ...f, account_id: "", account_platform: undefined }));
                }}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Back"
              >
                <ArrowLeft className="size-4" />
              </button>
            )}
            {selectedTemplate ? selectedTemplate.name : "Create Automation"}
          </DialogTitle>
          <DialogDescription>
            {selectedTemplate
              ? selectedTemplate.description
              : "Start from a template. The Flow Builder (coming next) will let you edit the generated graph."}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="grid grid-cols-2 gap-2 py-2">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelected(t.id)}
                className={cn(
                  "group flex flex-col items-start gap-1 rounded-md border border-border bg-background p-3 text-left transition-colors hover:border-foreground/30 hover:bg-accent/20",
                )}
              >
                <t.icon className="size-4 text-muted-foreground group-hover:text-foreground" />
                <div className="text-[13px] font-medium">{t.name}</div>
                <div className="text-[11px] text-muted-foreground leading-snug">{t.description}</div>
              </button>
            ))}
          </div>
        ) : (
          <ScrollArea className="max-h-[calc(100dvh-16rem)]">
            <div className="space-y-3 py-2 pr-4">
            <TextField
              label="Name"
              value={form.name}
              onChange={(v) => setForm((f) => ({ ...f, name: v }))}
              placeholder="e.g. Spring launch comment → DM"
            />
            <div>
              <label className="text-xs font-medium text-muted-foreground">Account</label>
              <div className="mt-1">
                <AccountSearchCombobox
                  value={form.account_id || null}
                  onSelect={(id) =>
                    setForm((f) => ({
                      ...f,
                      account_id: id || "",
                      ...(id ? {} : { account_platform: undefined }),
                    }))
                  }
                  onSelectAccount={(acc) =>
                    setForm((f) => ({
                      ...f,
                      account_platform: acc?.platform?.toLowerCase(),
                    }))
                  }
                  platforms={supportedPlatforms}
                  showAllOption={false}
                  placeholder="Select an account"
                  variant="input"
                />
              </div>
            </div>

            {(selected === "comment-to-dm" || selected === "giveaway") && (
              <div>
                <label className="text-xs font-medium text-muted-foreground">Post (optional)</label>
                <div className="mt-1">
                  <PostSearchCombobox
                    value={form.post_id || null}
                    onSelect={(id) => setForm((f) => ({ ...f, post_id: id ?? "" }))}
                    accountId={form.account_id || null}
                    placeholder={form.account_id ? "All posts on this account" : "Select an account first"}
                    variant="input"
                  />
                </div>
              </div>
            )}

            {(selected === "comment-to-dm" || selected === "keyword-reply") && (
              <>
                <TextField
                  label="Keywords (comma-separated)"
                  value={form.keywords ?? ""}
                  onChange={(v) => setForm((f) => ({ ...f, keywords: v }))}
                  placeholder="LINK, INFO, PRICE"
                />
                <SelectField
                  label="Match mode"
                  value={form.match_mode ?? "contains"}
                  onChange={(v) => setForm((f) => ({ ...f, match_mode: v as "contains" | "exact" }))}
                  options={["contains", "exact"]}
                />
              </>
            )}

            {selected === "comment-to-dm" && (
              <>
                <TextareaField
                  label="DM message"
                  value={form.dm_message ?? ""}
                  onChange={(v) => setForm((f) => ({ ...f, dm_message: v }))}
                  placeholder="Hey {{first_name}}! Here's the link you asked for."
                />
                <TextareaField
                  label="Public reply (optional)"
                  value={form.public_reply ?? ""}
                  onChange={(v) => setForm((f) => ({ ...f, public_reply: v }))}
                  placeholder="Check your DMs! 📨"
                  rows={2}
                />
              </>
            )}

            {(selected === "welcome-dm" || selected === "follow-to-dm") && (
              <TextareaField
                label="Welcome message"
                value={form.welcome_message ?? ""}
                onChange={(v) => setForm((f) => ({ ...f, welcome_message: v }))}
                placeholder="Hey {{first_name}} 👋 thanks for connecting!"
              />
            )}

            {selected === "keyword-reply" && (
              <TextareaField
                label="Reply message"
                value={form.reply_message ?? ""}
                onChange={(v) => setForm((f) => ({ ...f, reply_message: v }))}
                placeholder="Thanks for reaching out!"
              />
            )}

            {selected === "story-reply" && (
              <TextareaField
                label="DM message"
                value={form.dm_message ?? ""}
                onChange={(v) => setForm((f) => ({ ...f, dm_message: v }))}
                placeholder="Appreciate the story reply!"
              />
            )}

            {selected === "giveaway" && (
              <>
                <TextField
                  label="Entry keywords (comma-separated)"
                  value={form.entry_keywords ?? ""}
                  onChange={(v) => setForm((f) => ({ ...f, entry_keywords: v }))}
                  placeholder="ENTER, ME, IN"
                />
                <TextField
                  label="Entry tag"
                  value={form.entry_tag ?? "giveaway_entry"}
                  onChange={(v) => setForm((f) => ({ ...f, entry_tag: v }))}
                />
                <TextareaField
                  label="Confirmation DM"
                  value={form.confirmation_dm ?? ""}
                  onChange={(v) => setForm((f) => ({ ...f, confirmation_dm: v }))}
                  placeholder="You're entered! Good luck 🎉"
                />
              </>
            )}

            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}
            </div>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          {selected && (
            <Button type="button" size="sm" onClick={submit} disabled={submitting}>
              {submitting ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
              Create draft
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
      />
    </div>
  );
}

function TextareaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="mt-1 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}
