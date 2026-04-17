import { useMemo, useState } from "react";
import { Play, Loader2, X, CheckCircle2, XCircle, CircleDot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AutomationDetail, AutomationSchema } from "./types";

interface SimulateResult {
	enrollment_id?: string;
	executed?: Array<{
		node_key: string | null;
		node_type: string | null;
		outcome: string;
		branch_label: string | null;
		error: string | null;
	}>;
	final_status?: string;
	error?: string;
}

interface Props {
	automation: AutomationDetail;
	schema: AutomationSchema;
	onClose: () => void;
	onHighlightPath: (nodeKeys: string[]) => void;
}

const INPUT_CLS =
	"h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground";

export function SimulatorPanel({
	automation,
	schema,
	onClose,
	onHighlightPath,
}: Props) {
	const triggerDef = useMemo(
		() => schema.triggers.find((t) => t.type === automation.trigger.type),
		[schema, automation.trigger.type],
	);

	const [contactId, setContactId] = useState("");
	const [payloadText, setPayloadText] = useState("{}");
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<SimulateResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	const run = async () => {
		setLoading(true);
		setError(null);
		setResult(null);

		let payload: unknown = {};
		try {
			payload = payloadText.trim() ? JSON.parse(payloadText) : {};
		} catch {
			setError("Trigger payload must be valid JSON");
			setLoading(false);
			return;
		}

		try {
			const res = await fetch(`/api/automations/${automation.id}/simulate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contact_id: contactId || undefined,
					trigger_payload: payload,
				}),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				setError(body?.error?.message ?? `Error ${res.status}`);
			} else {
				const json = (await res.json()) as SimulateResult;
				setResult(json);
				const path = (json.executed ?? [])
					.map((s) => s.node_key)
					.filter((k): k is string => typeof k === "string");
				onHighlightPath(path);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : "Network error");
		} finally {
			setLoading(false);
		}
	};

	const clear = () => {
		setResult(null);
		setError(null);
		onHighlightPath([]);
	};

	return (
		<div className="w-80 border-l border-border bg-card/30 flex flex-col overflow-hidden">
			<div className="px-3 py-2 border-b border-border flex items-center justify-between">
				<div>
					<h3 className="text-xs font-medium">Simulator</h3>
					<p className="text-[10px] text-muted-foreground mt-0.5">
						Dry-run the automation with a synthetic trigger
					</p>
				</div>
				<button
					type="button"
					onClick={() => {
						clear();
						onClose();
					}}
					className="text-muted-foreground hover:text-foreground"
				>
					<X className="size-3.5" />
				</button>
			</div>

			<div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
				<div>
					<label className="text-[10px] font-medium text-muted-foreground block mb-1">
						Contact ID
					</label>
					<input
						type="text"
						value={contactId}
						onChange={(e) => setContactId(e.target.value)}
						placeholder="contact_abc (optional)"
						className={INPUT_CLS}
					/>
					<p className="text-[10px] text-muted-foreground/70 mt-0.5">
						Leave empty to simulate as an anonymous contact
					</p>
				</div>

				<div>
					<label className="text-[10px] font-medium text-muted-foreground block mb-1">
						Trigger payload
					</label>
					<textarea
						value={payloadText}
						onChange={(e) => setPayloadText(e.target.value)}
						rows={8}
						className="w-full text-xs font-mono rounded-md border border-input bg-background px-2 py-1.5 resize-y"
						spellCheck={false}
					/>
					{triggerDef && (
						<p className="text-[10px] text-muted-foreground/70 mt-0.5">
							Trigger: <span className="font-mono">{triggerDef.type}</span> ·{" "}
							{triggerDef.description ?? "no description"}
						</p>
					)}
				</div>

				<Button
					onClick={run}
					disabled={loading}
					size="sm"
					className="w-full h-7 text-xs gap-1.5"
				>
					{loading ? (
						<Loader2 className="size-3.5 animate-spin" />
					) : (
						<Play className="size-3.5" />
					)}
					Run simulation
				</Button>

				{error && (
					<div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
						{error}
					</div>
				)}

				{result && (
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<h4 className="text-[10px] font-medium text-muted-foreground">
								Executed path
							</h4>
							<button
								type="button"
								onClick={clear}
								className="text-[10px] text-muted-foreground hover:text-foreground"
							>
								clear
							</button>
						</div>
						{result.final_status && (
							<div className="text-[11px] text-muted-foreground">
								Final status:{" "}
								<span className="font-medium text-foreground">
									{result.final_status}
								</span>
							</div>
						)}
						<ol className="space-y-1">
							{(result.executed ?? []).map((step, i) => (
								<li
									key={i}
									className={cn(
										"rounded-md border px-2 py-1.5 text-[11px]",
										step.outcome === "success"
											? "border-emerald-500/30 bg-emerald-500/5"
											: step.outcome === "fail" || step.outcome === "error"
												? "border-destructive/30 bg-destructive/5"
												: "border-border bg-card",
									)}
								>
									<div className="flex items-center gap-1.5">
										{step.outcome === "success" ? (
											<CheckCircle2 className="size-3 text-emerald-400" />
										) : step.outcome === "fail" || step.outcome === "error" ? (
											<XCircle className="size-3 text-destructive" />
										) : (
											<CircleDot className="size-3 text-muted-foreground" />
										)}
										<span className="font-medium">
											{step.node_key ?? "(trigger)"}
										</span>
										{step.node_type && (
											<span className="text-muted-foreground">
												· {step.node_type.replace(/_/g, " ")}
											</span>
										)}
										{step.branch_label && (
											<span className="ml-auto rounded-full bg-muted px-1.5 py-0 text-[9px] font-medium text-muted-foreground">
												→ {step.branch_label}
											</span>
										)}
									</div>
									{step.error && (
										<div className="mt-0.5 text-destructive/80">{step.error}</div>
									)}
								</li>
							))}
						</ol>
					</div>
				)}
			</div>
		</div>
	);
}
