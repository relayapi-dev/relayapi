// Randomizer node editor.
//
// Mirrors `apps/api/src/services/automations/nodes/randomizer.ts`: weighted
// variants. Each variant's `key` drives an output port `variant.<key>` — the
// canvas re-derives handles from config automatically (derive-ports.ts), so
// adding/removing a variant updates the node's outputs live.

import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { Field, FormShell, numberOrUndefined } from "./shared";

interface Variant {
	key: string;
	weight: number;
}

interface RandomizerConfig {
	variants?: Variant[];
}

export function RandomizerEditor({
	config,
	onChange,
}: {
	config: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
}) {
	const cfg = config as RandomizerConfig;
	const variants = cfg.variants ?? [];
	const setVariants = (next: Variant[]) =>
		onChange({ ...config, variants: next });

	const totalWeight = variants.reduce((s, v) => s + (Number(v.weight) || 0), 0);

	const patchVariant = (idx: number, p: Partial<Variant>) => {
		const next = variants.slice();
		const current = next[idx];
		if (!current) return;
		next[idx] = { ...current, ...p };
		setVariants(next);
	};

	return (
		<FormShell>
			<Field
				label="Variants"
				description="Traffic is split across variants by weight. Each variant adds an output port."
			>
				<div className="space-y-2">
					{variants.map((variant, idx) => {
						const pct =
							totalWeight > 0
								? Math.round(((Number(variant.weight) || 0) / totalWeight) * 100)
								: 0;
						return (
							<div
								key={idx}
								className="flex items-center gap-1.5 rounded-lg border border-[#e6e9ef] bg-[#fbfcfe] p-2"
							>
								<input
									type="text"
									value={variant.key}
									onChange={(e) => patchVariant(idx, { key: e.target.value })}
									placeholder="variant key (e.g. a)"
									className="h-9 flex-1 rounded-lg border border-[#d9dde6] bg-white px-2 text-[12px]"
								/>
								<input
									type="number"
									min={0}
									value={variant.weight ?? ""}
									onChange={(e) =>
										patchVariant(idx, {
											weight: numberOrUndefined(e.target.value) ?? 0,
										})
									}
									placeholder="weight"
									className="h-9 w-20 rounded-lg border border-[#d9dde6] bg-white px-2 text-[12px]"
								/>
								<span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-[#64748b]">
									{pct}%
								</span>
								<button
									type="button"
									onClick={() =>
										setVariants(variants.filter((_, i) => i !== idx))
									}
									className="rounded p-1 text-[#94a3b8] hover:bg-[#fde8e8] hover:text-destructive"
									aria-label="Remove variant"
								>
									<Trash2 className="size-3.5" />
								</button>
							</div>
						);
					})}
					<button
						type="button"
						onClick={() => setVariants([...variants, { key: "", weight: 1 }])}
						className="flex h-8 w-full items-center justify-center gap-1 rounded-md border border-dashed border-[#d9dde6] text-[11px] text-[#475569] hover:bg-[#f0f1f4]"
					>
						<Plus className="size-3" />
						Add variant
					</button>
				</div>
			</Field>

			{variants.length === 0 ? (
				<p className="flex items-center gap-1.5 text-[11px] text-[#b45309]">
					<AlertTriangle className="size-3.5" />
					Add at least one variant — the node fails at runtime with none.
				</p>
			) : null}
		</FormShell>
	);
}
