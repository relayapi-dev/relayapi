import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	type AdProviderOptionsMode,
	providerOptionsTemplate,
} from "./provider-contract";

const providerHelp: Record<string, string> = {
	google:
		"Choose the EU political-ad declaration, then provide Search keywords and Responsive Search Ad assets. Do not leave template placeholders.",
	linkedin:
		"Choose political intent and provide approved targeting URNs, an associated entity, and an existing LinkedIn content reference.",
	pinterest:
		"Provide provider geo codes and bidding settings. Standalone ads need an existing Pin ID; boosts derive it from the selected post.",
	tiktok:
		"Provide advertiser-timezone schedule values, location IDs, and an authorized identity. Standalone ads need exactly one Spark item or uploaded video ID.",
	twitter:
		"Provide a funding instrument and explicitly consent to worldwide delivery. Standalone ads need an existing Tweet ID.",
};

function providerSettings(
	value: string,
	mode: AdProviderOptionsMode,
): Record<string, unknown> | undefined {
	try {
		const envelope = JSON.parse(value) as Record<string, unknown>;
		const settings = envelope[mode === "campaign" ? "settings" : "campaign"];
		return typeof settings === "object" && settings !== null
			? (settings as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function withProviderSetting(
	value: string,
	platform: string,
	mode: AdProviderOptionsMode,
	objective: string,
	key: string,
	setting: string | boolean,
): string {
	let envelope: Record<string, unknown>;
	try {
		envelope = JSON.parse(value) as Record<string, unknown>;
	} catch {
		envelope = JSON.parse(
			providerOptionsTemplate(platform, mode, objective),
		) as Record<string, unknown>;
	}
	const settingsKey = mode === "campaign" ? "settings" : "campaign";
	const settings = envelope[settingsKey];
	envelope[settingsKey] = {
		...(typeof settings === "object" && settings !== null ? settings : {}),
		[key]: setting,
	};
	return JSON.stringify(envelope, null, 2);
}

export function ProviderOptionsEditor({
	platform,
	mode,
	objective,
	value,
	onChange,
}: {
	platform: string | null | undefined;
	mode: AdProviderOptionsMode;
	objective: string;
	value: string;
	onChange: (value: string) => void;
}) {
	if (!platform || platform === "meta") return null;
	const settings = providerSettings(value, mode);
	const explicitDecision =
		platform === "google"
			? String(settings?.contains_eu_political_advertising ?? "")
			: platform === "linkedin"
				? String(settings?.political_intent ?? "")
				: "";

	return (
		<div className="border-t border-border pt-4">
			<div className="mb-2 flex items-center justify-between gap-3">
				<div>
					<label
						htmlFor={`${mode}-provider-options`}
						className="text-xs font-medium text-muted-foreground"
					>
						Provider options JSON
					</label>
					<p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
						{providerHelp[platform] ??
							"Complete the exact typed provider contract before submitting."}
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-7 shrink-0 gap-1 px-2 text-[10px]"
					onClick={() =>
						onChange(providerOptionsTemplate(platform, mode, objective))
					}
				>
					<RotateCcw className="size-3" />
					Reset template
				</Button>
			</div>
			{platform === "google" && (
				<label className="mb-3 block text-xs font-medium text-muted-foreground">
					EU political advertising
					<select
						value={explicitDecision}
						onChange={(event) =>
							onChange(
								withProviderSetting(
									value,
									platform,
									mode,
									objective,
									"contains_eu_political_advertising",
									event.target.value,
								),
							)
						}
						className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						<option value="CHOOSE_EXPLICITLY">Choose explicitly…</option>
						<option value="DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING">
							Does not contain EU political advertising
						</option>
						<option value="CONTAINS_EU_POLITICAL_ADVERTISING">
							Contains EU political advertising
						</option>
					</select>
				</label>
			)}
			{platform === "linkedin" && (
				<label className="mb-3 block text-xs font-medium text-muted-foreground">
					Political intent
					<select
						value={explicitDecision}
						onChange={(event) =>
							onChange(
								withProviderSetting(
									value,
									platform,
									mode,
									objective,
									"political_intent",
									event.target.value,
								),
							)
						}
						className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						<option value="CHOOSE_EXPLICITLY">Choose explicitly…</option>
						<option value="NOT_POLITICAL">Not political</option>
						<option value="POLITICAL">Political</option>
						<option value="NOT_DECLARED">Not declared</option>
					</select>
				</label>
			)}
			{platform === "twitter" && (
				<label className="mb-3 flex items-start gap-2 rounded-md border border-input px-3 py-2 text-xs text-muted-foreground">
					<input
						type="checkbox"
						checked={settings?.allow_worldwide_targeting === true}
						onChange={(event) =>
							onChange(
								withProviderSetting(
									value,
									platform,
									mode,
									objective,
									"allow_worldwide_targeting",
									event.target.checked,
								),
							)
						}
						className="mt-0.5 size-3.5"
					/>
					<span>
						I explicitly authorize worldwide delivery without narrower X
						targeting.
					</span>
				</label>
			)}
			<textarea
				id={`${mode}-provider-options`}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				spellCheck={false}
				className="min-h-64 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[11px] leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				aria-describedby={`${mode}-provider-options-warning`}
			/>
			<p
				id={`${mode}-provider-options-warning`}
				className="mt-1 text-[10px] text-muted-foreground"
			>
				Changing the objective resets its provider template. Provider and
				account permissions are still validated by the RelayAPI SDK request.
			</p>
		</div>
	);
}
