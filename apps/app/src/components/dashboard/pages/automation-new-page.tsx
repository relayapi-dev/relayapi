import { useMemo, useState } from "react";
import { ArrowLeft, Loader2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/use-api";
import type { AutomationSchema } from "@/components/dashboard/automation/flow-builder/types";

const INPUT_CLS =
	"h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground";

interface CreateResponse {
	id: string;
}

export function AutomationNewPage() {
	const { data: schema, loading: loadingSchema } =
		useApi<AutomationSchema>("automations/schema");

	const [name, setName] = useState("");
	const [channel, setChannel] = useState<string>("");
	const [triggerType, setTriggerType] = useState<string>("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const channels = useMemo(() => {
		if (!schema) return [];
		const set = new Set<string>();
		for (const t of schema.triggers) set.add(t.channel);
		return Array.from(set).sort();
	}, [schema]);

	const triggersForChannel = useMemo(() => {
		if (!schema || !channel) return [];
		return schema.triggers
			.filter((t) => t.channel === channel)
			.sort((a, b) => a.type.localeCompare(b.type));
	}, [schema, channel]);

	const selectedTrigger = useMemo(
		() => triggersForChannel.find((t) => t.type === triggerType) ?? null,
		[triggersForChannel, triggerType],
	);

	const canSubmit = name.trim() && channel && triggerType && !submitting;

	const submit = async () => {
		if (!canSubmit) return;
		setSubmitting(true);
		setError(null);
		try {
			const res = await fetch("/api/automations", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					channel,
					trigger: { type: triggerType },
					nodes: [],
					edges: [],
				}),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				setError(body?.error?.message ?? `Error ${res.status}`);
				return;
			}
			const created = (await res.json()) as CreateResponse;
			window.location.href = `/app/automation/${created.id}`;
		} catch (e) {
			setError(e instanceof Error ? e.message : "Network error");
		} finally {
			setSubmitting(false);
		}
	};

	if (loadingSchema) {
		return (
			<div className="flex items-center justify-center py-20">
				<Loader2 className="size-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (!schema) {
		return (
			<div className="space-y-4">
				<a
					href="/app/automation"
					className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft className="size-3.5" />
					Back to automations
				</a>
				<div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
					Failed to load automation schema
				</div>
			</div>
		);
	}

	return (
		<div className="max-w-xl mx-auto space-y-6">
			<div>
				<a
					href="/app/automation"
					className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-2"
				>
					<ArrowLeft className="size-3.5" />
					Back to automations
				</a>
				<div className="flex items-center gap-2">
					<Workflow className="size-5 text-muted-foreground" />
					<h1 className="text-lg font-medium">New automation</h1>
				</div>
				<p className="text-xs text-muted-foreground mt-1">
					Create an empty draft. You'll design the flow in the editor.
				</p>
			</div>

			<div className="space-y-4 rounded-md border border-border bg-card/40 p-4">
				<div>
					<label className="text-xs font-medium text-muted-foreground block mb-1">
						Name
					</label>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="e.g. Welcome new Instagram DMs"
						className={INPUT_CLS}
					/>
				</div>

				<div>
					<label className="text-xs font-medium text-muted-foreground block mb-1">
						Channel
					</label>
					<select
						value={channel}
						onChange={(e) => {
							setChannel(e.target.value);
							setTriggerType("");
						}}
						className={INPUT_CLS}
					>
						<option value="">Select channel…</option>
						{channels.map((c) => (
							<option key={c} value={c}>
								{c}
							</option>
						))}
					</select>
				</div>

				<div>
					<label className="text-xs font-medium text-muted-foreground block mb-1">
						Trigger
					</label>
					<select
						value={triggerType}
						onChange={(e) => setTriggerType(e.target.value)}
						disabled={!channel}
						className={INPUT_CLS}
					>
						<option value="">
							{channel ? "Select trigger…" : "Choose a channel first"}
						</option>
						{triggersForChannel.map((t) => (
							<option key={t.type} value={t.type}>
								{t.type.replace(/_/g, " ")}
							</option>
						))}
					</select>
					{selectedTrigger?.description && (
						<p className="text-[11px] text-muted-foreground mt-1">
							{selectedTrigger.description}
						</p>
					)}
				</div>

				{error && (
					<div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
						{error}
					</div>
				)}

				<div className="flex justify-end gap-2 pt-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							window.location.href = "/app/automation";
						}}
						className="h-8 text-xs"
					>
						Cancel
					</Button>
					<Button
						size="sm"
						onClick={submit}
						disabled={!canSubmit}
						className="h-8 text-xs gap-1.5"
					>
						{submitting && <Loader2 className="size-3.5 animate-spin" />}
						Create draft
					</Button>
				</div>
			</div>
		</div>
	);
}
