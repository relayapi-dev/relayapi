import { Loader2, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useMutation } from "@/hooks/use-api";
import { cn } from "@/lib/utils";
import { AdAccountCombobox, type AdAccountOption } from "./ad-account-combobox";
import { PostTargetCombobox } from "./post-target-combobox";
import {
	type AdPlatformCapabilities,
	objectivesForPlatform,
	parseProviderOptions,
	providerOptionsTemplate,
	validateBudget,
	validateProviderBudgetAlignment,
	writeCapability,
} from "./provider-contract";
import { ProviderOptionsEditor } from "./provider-options-editor";

interface AdAccount {
	id: string;
	social_account_id: string | null;
	platform: string;
	name: string | null;
	currency: string | null;
	boostable_social_account_ids?: string[];
	capabilities?: AdAccountOption["capabilities"];
}

interface CreateAdDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	adAccounts: AdAccount[];
	platformCapabilities: AdPlatformCapabilities[];
	onCreated: () => void;
	boostMode?: boolean;
}

const ctaOptions = [
	"LEARN_MORE",
	"SHOP_NOW",
	"SIGN_UP",
	"BOOK_NOW",
	"CONTACT_US",
	"APPLY_NOW",
	"SUBSCRIBE",
	"DOWNLOAD",
] as const;

// Ad-account platform -> social platforms whose published posts it can boost.
const adToSocialPlatforms: Record<string, string[]> = {
	meta: ["facebook", "instagram"],
	twitter: ["twitter"],
	tiktok: ["tiktok"],
	linkedin: ["linkedin"],
	pinterest: ["pinterest"],
};

const inputClass =
	"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function CreateAdDialog({
	open,
	onOpenChange,
	adAccounts,
	platformCapabilities,
	onCreated,
	boostMode = false,
}: CreateAdDialogProps) {
	const [error, setError] = useState<string | null>(null);

	// Form state
	const [adAccountId, setAdAccountId] = useState("");
	const [selectedAccountOverride, setSelectedAccountOverride] =
		useState<AdAccountOption | null>(null);
	const [name, setName] = useState("");
	const [objective, setObjective] = useState<string>("engagement");
	const [headline, setHeadline] = useState("");
	const [body, setBody] = useState("");
	const [callToAction, setCallToAction] = useState("");
	const [linkUrl, setLinkUrl] = useState("");
	const [imageUrl, setImageUrl] = useState("");
	const [videoUrl, setVideoUrl] = useState("");
	const [dailyBudget, setDailyBudget] = useState("");
	const [lifetimeBudget, setLifetimeBudget] = useState("");
	const [durationDays, setDurationDays] = useState("7");
	const [startDate, setStartDate] = useState("");
	const [endDate, setEndDate] = useState("");
	const [providerOptions, setProviderOptions] = useState("");

	// Boost-specific
	const [postTargetId, setPostTargetId] = useState("");
	// Connected social accounts the selected ad account can boost (null = unknown).
	const [boostableAccountIds, setBoostableAccountIds] = useState<
		string[] | null
	>(null);

	// Targeting
	const [ageMin, setAgeMin] = useState("18");
	const [ageMax, setAgeMax] = useState("65");
	const [genders, setGenders] = useState<string[]>([]);
	const [interestQuery, setInterestQuery] = useState("");
	const [interests, setInterests] = useState<{ id: string; name: string }[]>(
		[],
	);
	const [interestResults, setInterestResults] = useState<
		{ id: string; name: string; audience_size?: number }[]
	>([]);
	const [searchingInterests, setSearchingInterests] = useState(false);
	const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
	const operationRef = useRef<{ requestBody: string; key: string } | null>(
		null,
	);
	const createMutation = useMutation<{ data?: { id: string }; id?: string }>(
		boostMode ? "ads/boost" : "ads",
		"POST",
	);

	const selectedAccount =
		selectedAccountOverride ??
		adAccounts.find((account) => account.id === adAccountId);
	const effectivePlatform = selectedAccount?.platform ?? null;
	const objectives = objectivesForPlatform(
		effectivePlatform,
		platformCapabilities,
	);
	const operationCapability = writeCapability(
		selectedAccount,
		boostMode ? "boost" : "ad_create",
		platformCapabilities,
	);
	const campaignCapability = boostMode
		? undefined
		: writeCapability(selectedAccount, "campaign_create", platformCapabilities);
	const unavailableCapability = {
		state: "unsupported" as const,
		reason:
			"Provider capabilities are unavailable. Refresh before creating paid objects.",
	};
	const blockedCapability = !selectedAccount
		? undefined
		: operationCapability?.state !== "supported"
			? (operationCapability ?? unavailableCapability)
			: !boostMode && campaignCapability?.state !== "supported"
				? (campaignCapability ?? unavailableCapability)
				: undefined;

	// Set default ad account
	useEffect(() => {
		const firstAccount = adAccounts[0];
		if (firstAccount && !adAccountId) {
			setAdAccountId(firstAccount.id);
		}
	}, [adAccounts, adAccountId]);

	useEffect(() => {
		if (!open || !effectivePlatform) return;
		const nextObjective = objectives.includes(objective)
			? objective
			: (objectives[0] ?? "awareness");
		setObjective(nextObjective);
		setProviderOptions(
			providerOptionsTemplate(
				effectivePlatform,
				boostMode ? "boost" : "ad",
				nextObjective,
			),
		);
	}, [open, effectivePlatform, boostMode, platformCapabilities]);

	// Interest autocomplete
	useEffect(() => {
		if (
			effectivePlatform !== "meta" ||
			!interestQuery ||
			interestQuery.length < 2
		) {
			setInterestResults([]);
			return;
		}
		if (searchTimeout.current) clearTimeout(searchTimeout.current);
		if (!selectedAccount) return;

		searchTimeout.current = setTimeout(async () => {
			setSearchingInterests(true);
			try {
				const res = await fetch(
					`/api/ads/interests?q=${encodeURIComponent(interestQuery)}&ad_account_id=${encodeURIComponent(selectedAccount.id)}`,
				);
				if (res.ok) {
					const data = await res.json();
					setInterestResults(data.data ?? data ?? []);
				}
			} catch {
				/* ignore */
			}
			setSearchingInterests(false);
		}, 400);

		return () => {
			if (searchTimeout.current) clearTimeout(searchTimeout.current);
		};
	}, [interestQuery, selectedAccount, effectivePlatform]);

	const resetForm = () => {
		setName("");
		setObjective("engagement");
		setHeadline("");
		setBody("");
		setCallToAction("");
		setLinkUrl("");
		setImageUrl("");
		setVideoUrl("");
		setDailyBudget("");
		setLifetimeBudget("");
		setDurationDays("7");
		setStartDate("");
		setEndDate("");
		setPostTargetId("");
		setProviderOptions(
			providerOptionsTemplate(
				effectivePlatform,
				boostMode ? "boost" : "ad",
				objective,
			),
		);
		setAgeMin("18");
		setAgeMax("65");
		setGenders([]);
		setInterestQuery("");
		setInterests([]);
		setInterestResults([]);
		setError(null);
		operationRef.current = null;
	};

	const handleSubmit = async () => {
		setError(null);

		if (!selectedAccount) {
			setError("Select an ad account.");
			return;
		}
		if (blockedCapability) {
			setError(
				blockedCapability.reason ??
					`${boostMode ? "Boosting" : "Ad creation"} is not supported for this account.`,
			);
			return;
		}
		if (boostMode && !postTargetId) {
			setError("Select a published post to boost.");
			return;
		}

		const toCents = (value: string): number | undefined => {
			if (!value) return undefined;
			const parsed = Number.parseFloat(value);
			return Number.isFinite(parsed) && parsed > 0
				? Math.round(parsed * 100)
				: undefined;
		};
		const dailyCents = toCents(dailyBudget);
		const lifetimeCents = toCents(lifetimeBudget);
		if (dailyBudget && dailyCents === undefined) {
			setError("Daily budget must be greater than zero.");
			return;
		}
		if (lifetimeBudget && lifetimeCents === undefined) {
			setError("Lifetime budget must be greater than zero.");
			return;
		}
		const budgetError = validateBudget(
			effectivePlatform,
			boostMode ? "boost" : "ad",
			dailyCents,
			lifetimeCents,
			startDate,
			endDate,
		);
		if (budgetError) {
			setError(budgetError);
			return;
		}
		const parsedDuration = Number(durationDays);
		if (
			!Number.isInteger(parsedDuration) ||
			parsedDuration < 1 ||
			parsedDuration > 365
		) {
			setError("Duration must be between 1 and 365 days.");
			return;
		}
		const parsedProviderOptions = parseProviderOptions(
			effectivePlatform,
			boostMode ? "boost" : "ad",
			objective,
			providerOptions,
		);
		if (parsedProviderOptions.error) {
			setError(parsedProviderOptions.error);
			return;
		}
		const providerBudgetError = validateProviderBudgetAlignment(
			effectivePlatform,
			boostMode ? "boost" : "ad",
			parsedProviderOptions.value,
			dailyCents,
			lifetimeCents,
		);
		if (providerBudgetError) {
			setError(providerBudgetError);
			return;
		}

		const targeting: Record<string, unknown> = {};
		if (effectivePlatform === "meta") {
			if (ageMin !== "18") targeting.age_min = Number(ageMin);
			if (ageMax !== "65") targeting.age_max = Number(ageMax);
			if (genders.length > 0) targeting.genders = genders;
			if (interests.length > 0) targeting.interests = interests;
		}

		try {
			const payload: Record<string, unknown> = {
				ad_account_id: adAccountId,
				name: name || (boostMode ? "Boost" : "New Ad"),
				objective,
				...(Object.keys(targeting).length > 0 ? { targeting } : {}),
				...(parsedProviderOptions.value
					? { provider_options: parsedProviderOptions.value }
					: {}),
			};

			if (boostMode) {
				// Native/external posts use an xp_ id (external_post_id); RelayAPI posts
				// use a pt_ post target id (post_target_id).
				if (postTargetId.startsWith("xp_"))
					payload.external_post_id = postTargetId;
				else payload.post_target_id = postTargetId;
				payload.daily_budget_cents = dailyCents;
				payload.duration_days = parsedDuration;
			} else {
				if (effectivePlatform === "meta") {
					if (headline) payload.headline = headline;
					if (body) payload.body = body;
					if (callToAction) payload.call_to_action = callToAction;
					if (linkUrl) payload.link_url = linkUrl;
					if (imageUrl) payload.image_url = imageUrl;
					if (videoUrl) payload.video_url = videoUrl;
				}
				if (dailyCents !== undefined) payload.daily_budget_cents = dailyCents;
				if (lifetimeCents !== undefined)
					payload.lifetime_budget_cents = lifetimeCents;
				payload.duration_days = parsedDuration;
				if (startDate) payload.start_date = new Date(startDate).toISOString();
				if (endDate) payload.end_date = new Date(endDate).toISOString();
			}

			const requestBody = JSON.stringify(payload);
			if (operationRef.current?.requestBody !== requestBody) {
				operationRef.current = { requestBody, key: crypto.randomUUID() };
			}
			payload.operation_id = operationRef.current.key;

			const result = await createMutation.mutate(payload);
			if (!result) return;

			resetForm();
			onOpenChange(false);
			onCreated();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to create ad");
		}
	};

	const toggleGender = (g: string) => {
		setGenders((prev) =>
			prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g],
		);
	};

	const compatiblePlatforms = effectivePlatform
		? (adToSocialPlatforms[effectivePlatform] ?? [])
		: undefined;
	// Scope the post picker to the connected accounts this ad account can boost.
	const effectiveBoostableIds =
		boostableAccountIds ?? selectedAccount?.boostable_social_account_ids;

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) resetForm();
				onOpenChange(o);
			}}
		>
			<DialogContent className="max-w-lg max-h-[85vh] grid-rows-[auto_1fr] overflow-hidden">
				<DialogHeader>
					<DialogTitle>{boostMode ? "Boost Post" : "Create Ad"}</DialogTitle>
					<DialogDescription>
						{boostMode
							? "Promote a published post as a paid ad"
							: "Create a standalone paid ad"}
					</DialogDescription>
				</DialogHeader>
				<ScrollArea className="min-h-0 -mr-6">
					<div className="space-y-4 pl-0.5 pr-6">
						{/* Ad Account */}
						<div>
							<span className="text-xs text-muted-foreground mb-1 block">
								Ad Account
							</span>
							<AdAccountCombobox
								value={adAccountId}
								onSelect={setAdAccountId}
								onSelectAccount={(acc) => {
									setSelectedAccountOverride(acc);
									setBoostableAccountIds(
										acc?.boostable_social_account_ids ?? null,
									);
								}}
							/>
						</div>

						{adAccountId && blockedCapability && (
							<div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
								{blockedCapability.reason ??
									`${boostMode ? "Boosting" : "Ad creation"} is unavailable for this provider.`}
							</div>
						)}

						{/* Boost: Post picker */}
						{boostMode && (
							<div>
								<span className="text-xs text-muted-foreground mb-1 block">
									Post to boost
								</span>
								<PostTargetCombobox
									value={postTargetId || null}
									onSelect={(id) => setPostTargetId(id ?? "")}
									platforms={compatiblePlatforms}
									accountIds={effectiveBoostableIds}
								/>
								<p className="text-[10px] text-muted-foreground mt-1">
									Pick a published post to promote as a paid ad
								</p>
							</div>
						)}

						{/* Name */}
						<div>
							<label
								htmlFor="ad-name"
								className="text-xs text-muted-foreground mb-1 block"
							>
								Name
							</label>
							<input
								id="ad-name"
								className={inputClass}
								placeholder="Ad name"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</div>

						{/* Objective */}
						<div>
							<label
								htmlFor="ad-objective"
								className="text-xs text-muted-foreground mb-1 block"
							>
								Objective
							</label>
							<select
								id="ad-objective"
								value={objective}
								onChange={(event) => {
									const nextObjective = event.target.value;
									setObjective(nextObjective);
									setProviderOptions(
										providerOptionsTemplate(
											effectivePlatform,
											boostMode ? "boost" : "ad",
											nextObjective,
										),
									);
								}}
								className={inputClass}
							>
								{objectives.map((o) => (
									<option key={o} value={o}>
										{o.charAt(0).toUpperCase() + o.slice(1).replace("_", " ")}
									</option>
								))}
							</select>
						</div>

						{/* Creative (non-boost only) */}
						{!boostMode && effectivePlatform === "meta" && (
							<div className="border-t border-border pt-4">
								<p className="text-xs font-medium text-muted-foreground mb-3">
									Creative
								</p>
								<div className="space-y-3">
									<input
										className={inputClass}
										placeholder="Headline"
										value={headline}
										onChange={(e) => setHeadline(e.target.value)}
									/>
									<textarea
										className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
										placeholder="Ad body text"
										value={body}
										onChange={(e) => setBody(e.target.value)}
									/>
									<div className="grid grid-cols-2 gap-3">
										<div>
											<label
												htmlFor="ad-cta"
												className="text-[10px] text-muted-foreground mb-1 block"
											>
												Call to Action
											</label>
											<select
												id="ad-cta"
												value={callToAction}
												onChange={(e) => setCallToAction(e.target.value)}
												className={inputClass}
											>
												<option value="">None</option>
												{ctaOptions.map((c) => (
													<option key={c} value={c}>
														{c.replace(/_/g, " ")}
													</option>
												))}
											</select>
										</div>
										<div>
											<label
												htmlFor="ad-link-url"
												className="text-[10px] text-muted-foreground mb-1 block"
											>
												Link URL
											</label>
											<input
												id="ad-link-url"
												className={inputClass}
												placeholder="https://..."
												value={linkUrl}
												onChange={(e) => setLinkUrl(e.target.value)}
											/>
										</div>
									</div>
									<div className="grid grid-cols-2 gap-3">
										<input
											className={inputClass}
											placeholder="Image URL"
											value={imageUrl}
											onChange={(e) => setImageUrl(e.target.value)}
										/>
										<input
											className={inputClass}
											placeholder="Video URL"
											value={videoUrl}
											onChange={(e) => setVideoUrl(e.target.value)}
										/>
									</div>
								</div>
							</div>
						)}

						{/* Budget */}
						<div className="border-t border-border pt-4">
							<p className="text-xs font-medium text-muted-foreground mb-3">
								Budget
							</p>
							<div className="grid grid-cols-2 gap-3">
								<div>
									<label
										htmlFor="ad-daily-budget"
										className="text-[10px] text-muted-foreground mb-1 block"
									>
										Daily ($)
									</label>
									<input
										id="ad-daily-budget"
										className={inputClass}
										type="number"
										step="0.01"
										min="0"
										placeholder="0.00"
										value={dailyBudget}
										onChange={(e) => setDailyBudget(e.target.value)}
									/>
								</div>
								{!boostMode && effectivePlatform !== "twitter" && (
									<div>
										<label
											htmlFor="ad-lifetime-budget"
											className="text-[10px] text-muted-foreground mb-1 block"
										>
											Lifetime ($)
										</label>
										<input
											id="ad-lifetime-budget"
											className={inputClass}
											type="number"
											step="0.01"
											min="0"
											placeholder="0.00"
											value={lifetimeBudget}
											onChange={(e) => setLifetimeBudget(e.target.value)}
										/>
									</div>
								)}
								<div>
									<label
										htmlFor="ad-duration"
										className="text-[10px] text-muted-foreground mb-1 block"
									>
										Duration (days)
									</label>
									<input
										id="ad-duration"
										className={inputClass}
										type="number"
										min="1"
										max="365"
										value={durationDays}
										onChange={(e) => setDurationDays(e.target.value)}
									/>
								</div>
							</div>
							{!boostMode && (
								<div className="grid grid-cols-2 gap-3 mt-3">
									<div>
										<label
											htmlFor="ad-start-date"
											className="text-[10px] text-muted-foreground mb-1 block"
										>
											Start Date
										</label>
										<input
											id="ad-start-date"
											className={inputClass}
											type="date"
											value={startDate}
											onChange={(e) => setStartDate(e.target.value)}
										/>
									</div>
									<div>
										<label
											htmlFor="ad-end-date"
											className="text-[10px] text-muted-foreground mb-1 block"
										>
											End Date
										</label>
										<input
											id="ad-end-date"
											className={inputClass}
											type="date"
											value={endDate}
											onChange={(e) => setEndDate(e.target.value)}
										/>
									</div>
								</div>
							)}
						</div>

						{/* Targeting */}
						{effectivePlatform === "meta" && (
							<div className="border-t border-border pt-4">
								<p className="text-xs font-medium text-muted-foreground mb-3">
									Targeting
								</p>
								<div className="space-y-3">
									{/* Age */}
									<div className="grid grid-cols-2 gap-3">
										<div>
											<label
												htmlFor="ad-age-min"
												className="text-[10px] text-muted-foreground mb-1 block"
											>
												Min Age
											</label>
											<input
												id="ad-age-min"
												className={inputClass}
												type="number"
												min="13"
												max="65"
												value={ageMin}
												onChange={(e) => setAgeMin(e.target.value)}
											/>
										</div>
										<div>
											<label
												htmlFor="ad-age-max"
												className="text-[10px] text-muted-foreground mb-1 block"
											>
												Max Age
											</label>
											<input
												id="ad-age-max"
												className={inputClass}
												type="number"
												min="13"
												max="65"
												value={ageMax}
												onChange={(e) => setAgeMax(e.target.value)}
											/>
										</div>
									</div>

									{/* Gender */}
									<div>
										<span className="text-[10px] text-muted-foreground mb-1 block">
											Gender
										</span>
										<div className="flex gap-2">
											{["male", "female", "all"].map((g) => (
												<button
													key={g}
													type="button"
													onClick={() => toggleGender(g)}
													className={cn(
														"px-3 py-1.5 text-xs rounded-md transition-colors border",
														genders.includes(g)
															? "bg-primary text-primary-foreground border-primary"
															: "border-input text-muted-foreground hover:text-foreground",
													)}
												>
													{g.charAt(0).toUpperCase() + g.slice(1)}
												</button>
											))}
										</div>
									</div>

									{/* Interests */}
									<div>
										<label
											htmlFor="ad-interests"
											className="text-[10px] text-muted-foreground mb-1 block"
										>
											Interests
										</label>
										<div className="relative">
											<Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
											<input
												id="ad-interests"
												className={cn(inputClass, "pl-8")}
												placeholder="Search interests..."
												value={interestQuery}
												onChange={(e) => setInterestQuery(e.target.value)}
											/>
											{searchingInterests && (
												<Loader2 className="absolute right-2.5 top-2.5 size-3.5 animate-spin text-muted-foreground" />
											)}
										</div>
										{interestResults.length > 0 && (
											<ScrollArea className="mt-1 max-h-32 rounded-md border border-border bg-popover p-1">
												{interestResults.map((ir) => (
													<button
														key={ir.id}
														type="button"
														className="w-full px-2 py-1.5 text-xs text-left rounded hover:bg-accent transition-colors flex justify-between"
														onClick={() => {
															if (!interests.find((i) => i.id === ir.id)) {
																setInterests((prev) => [
																	...prev,
																	{ id: ir.id, name: ir.name },
																]);
															}
															setInterestQuery("");
															setInterestResults([]);
														}}
													>
														<span>{ir.name}</span>
														{ir.audience_size != null && (
															<span className="text-muted-foreground">
																{ir.audience_size.toLocaleString()}
															</span>
														)}
													</button>
												))}
											</ScrollArea>
										)}
										{interests.length > 0 && (
											<div className="flex flex-wrap gap-1 mt-2">
												{interests.map((i) => (
													<span
														key={i.id}
														className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[11px]"
													>
														{i.name}
														<button
															type="button"
															onClick={() =>
																setInterests((prev) =>
																	prev.filter((x) => x.id !== i.id),
																)
															}
															className="hover:text-destructive"
														>
															&times;
														</button>
													</span>
												))}
											</div>
										)}
									</div>
								</div>
							</div>
						)}

						<ProviderOptionsEditor
							platform={effectivePlatform}
							mode={boostMode ? "boost" : "ad"}
							objective={objective}
							value={providerOptions}
							onChange={setProviderOptions}
						/>

						{(error || createMutation.error) && (
							<p className="text-sm text-destructive">
								{error || createMutation.error}
							</p>
						)}

						<Button
							onClick={handleSubmit}
							disabled={
								createMutation.loading ||
								!adAccountId ||
								Boolean(blockedCapability) ||
								(boostMode && !postTargetId)
							}
							className="w-full gap-1.5"
						>
							{createMutation.loading ? (
								<Loader2 className="size-4 animate-spin" />
							) : null}
							{createMutation.loading
								? "Creating..."
								: boostMode
									? "Boost Post"
									: "Create Ad"}
						</Button>
					</div>
				</ScrollArea>
			</DialogContent>
		</Dialog>
	);
}
