import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useMutation } from "@/hooks/use-api";
import { AdAccountCombobox, type AdAccountOption } from "./ad-account-combobox";
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
	platform: string;
	name: string | null;
	currency: string | null;
	capabilities?: AdAccountOption["capabilities"];
}

interface CreateCampaignDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	adAccounts: AdAccount[];
	platformCapabilities: AdPlatformCapabilities[];
	onCreated: () => void;
}

const inputClass =
	"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function CreateCampaignDialog({
	open,
	onOpenChange,
	adAccounts,
	platformCapabilities,
	onCreated,
}: CreateCampaignDialogProps) {
	const [adAccountId, setAdAccountId] = useState("");
	const [selectedAccountOverride, setSelectedAccountOverride] =
		useState<AdAccountOption | null>(null);
	const [name, setName] = useState("");
	const [objective, setObjective] = useState("awareness");
	const [dailyBudget, setDailyBudget] = useState("");
	const [lifetimeBudget, setLifetimeBudget] = useState("");
	const [currency, setCurrency] = useState("USD");
	const [startDate, setStartDate] = useState("");
	const [endDate, setEndDate] = useState("");
	const [providerOptions, setProviderOptions] = useState("");
	const [error, setError] = useState<string | null>(null);
	const operationRef = useRef<{ requestBody: string; key: string } | null>(
		null,
	);

	const createMutation = useMutation<{ id: string }>("ads/campaigns", "POST");

	useEffect(() => {
		if (!open) {
			setAdAccountId("");
			setSelectedAccountOverride(null);
			setName("");
			setObjective("awareness");
			setDailyBudget("");
			setLifetimeBudget("");
			setCurrency("USD");
			setStartDate("");
			setEndDate("");
			setProviderOptions("");
			setError(null);
			operationRef.current = null;
		}
	}, [open]);

	// Auto-fill currency when ad account is selected
	useEffect(() => {
		const account = adAccounts.find((a) => a.id === adAccountId);
		if (account?.currency) setCurrency(account.currency);
	}, [adAccountId, adAccounts]);

	const selectedAccount =
		selectedAccountOverride ??
		adAccounts.find((account) => account.id === adAccountId);
	const platform = selectedAccount?.platform ?? null;
	const objectives = objectivesForPlatform(platform, platformCapabilities);
	const capability = writeCapability(
		selectedAccount,
		"campaign_create",
		platformCapabilities,
	);

	useEffect(() => {
		if (!platform) return;
		const nextObjective = objectives.includes(objective)
			? objective
			: (objectives[0] ?? "awareness");
		setObjective(nextObjective);
		setProviderOptions(
			providerOptionsTemplate(platform, "campaign", nextObjective),
		);
	}, [platform, platformCapabilities]);

	const dollarsToCents = (value: string): number | undefined => {
		const parsed = Number.parseFloat(value);
		if (Number.isNaN(parsed) || parsed <= 0) return undefined;
		return Math.round(parsed * 100);
	};

	const handleSubmit = async () => {
		setError(null);
		if (!adAccountId || !name.trim()) {
			setError("Ad account and campaign name are required.");
			return;
		}
		if (capability?.state !== "supported") {
			setError(
				capability?.reason ??
					"Campaign creation is not supported for this ad account.",
			);
			return;
		}

		const dailyCents = dailyBudget ? dollarsToCents(dailyBudget) : undefined;
		const lifetimeCents = lifetimeBudget
			? dollarsToCents(lifetimeBudget)
			: undefined;
		if (dailyBudget && dailyCents === undefined) {
			setError("Daily budget must be greater than zero.");
			return;
		}
		if (lifetimeBudget && lifetimeCents === undefined) {
			setError("Lifetime budget must be greater than zero.");
			return;
		}
		const budgetError = validateBudget(
			platform,
			"campaign",
			dailyCents,
			lifetimeCents,
			startDate,
			endDate,
		);
		if (budgetError) {
			setError(budgetError);
			return;
		}
		const parsedProviderOptions = parseProviderOptions(
			platform,
			"campaign",
			objective,
			providerOptions,
		);
		if (parsedProviderOptions.error) {
			setError(parsedProviderOptions.error);
			return;
		}
		const providerBudgetError = validateProviderBudgetAlignment(
			platform,
			"campaign",
			parsedProviderOptions.value,
			dailyCents,
			lifetimeCents,
		);
		if (providerBudgetError) {
			setError(providerBudgetError);
			return;
		}

		const body: Record<string, unknown> = {
			ad_account_id: adAccountId,
			name: name.trim(),
			objective,
			currency,
			...(parsedProviderOptions.value
				? { provider_options: parsedProviderOptions.value }
				: {}),
		};

		if (dailyCents !== undefined) body.daily_budget_cents = dailyCents;
		if (lifetimeCents !== undefined) body.lifetime_budget_cents = lifetimeCents;
		if (startDate) body.start_date = new Date(startDate).toISOString();
		if (endDate) body.end_date = new Date(endDate).toISOString();

		const requestBody = JSON.stringify(body);
		if (operationRef.current?.requestBody !== requestBody) {
			operationRef.current = { requestBody, key: crypto.randomUUID() };
		}
		body.operation_id = operationRef.current.key;

		const result = await createMutation.mutate(body);
		if (result) {
			operationRef.current = null;
			onCreated();
			onOpenChange(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
				<DialogHeader>
					<DialogTitle className="text-base">Create Campaign</DialogTitle>
					<DialogDescription className="text-xs">
						Set up a new ad campaign across your connected ad accounts.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3 py-2">
					{/* Ad Account */}
					<div>
						<label
							htmlFor="campaign-account"
							className="text-xs font-medium text-muted-foreground"
						>
							Ad Account
						</label>
						<div className="mt-1">
							<AdAccountCombobox
								value={adAccountId}
								onSelect={setAdAccountId}
								onSelectAccount={setSelectedAccountOverride}
							/>
						</div>
					</div>

					{/* Name */}
					<div>
						<label
							htmlFor="campaign-name"
							className="text-xs font-medium text-muted-foreground"
						>
							Campaign Name
						</label>
						<input
							id="campaign-name"
							type="text"
							placeholder="e.g. Spring Sale 2026"
							value={name}
							onChange={(e) => setName(e.target.value)}
							className={`mt-1 ${inputClass}`}
						/>
					</div>

					{/* Objective */}
					<div>
						<label
							htmlFor="campaign-objective"
							className="text-xs font-medium text-muted-foreground"
						>
							Objective
						</label>
						<select
							id="campaign-objective"
							value={objective}
							onChange={(event) => {
								const nextObjective = event.target.value;
								setObjective(nextObjective);
								setProviderOptions(
									providerOptionsTemplate(platform, "campaign", nextObjective),
								);
							}}
							className={`mt-1 ${inputClass}`}
						>
							{objectives.map((value) => (
								<option key={value} value={value}>
									{value.charAt(0).toUpperCase() +
										value.slice(1).replace("_", " ")}
								</option>
							))}
						</select>
					</div>

					{/* Budgets */}
					<div className="grid grid-cols-2 gap-3">
						<div>
							<label
								htmlFor="campaign-daily-budget"
								className="text-xs font-medium text-muted-foreground"
							>
								Daily Budget ($)
							</label>
							<input
								id="campaign-daily-budget"
								type="number"
								min="0"
								step="0.01"
								placeholder="50.00"
								value={dailyBudget}
								onChange={(e) => setDailyBudget(e.target.value)}
								className={`mt-1 ${inputClass}`}
							/>
						</div>
						{platform !== "twitter" && (
							<div>
								<label
									htmlFor="campaign-lifetime-budget"
									className="text-xs font-medium text-muted-foreground"
								>
									Lifetime Budget ($)
								</label>
								<input
									id="campaign-lifetime-budget"
									type="number"
									min="0"
									step="0.01"
									placeholder="500.00"
									value={lifetimeBudget}
									onChange={(e) => setLifetimeBudget(e.target.value)}
									className={`mt-1 ${inputClass}`}
								/>
							</div>
						)}
					</div>

					{adAccountId && capability?.state !== "supported" && (
						<div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
							{capability?.reason ??
								"Campaign capability is unavailable for this ad account."}
						</div>
					)}

					<ProviderOptionsEditor
						platform={platform}
						mode="campaign"
						objective={objective}
						value={providerOptions}
						onChange={setProviderOptions}
					/>

					{/* Currency */}
					<div>
						<label
							htmlFor="campaign-currency"
							className="text-xs font-medium text-muted-foreground"
						>
							Currency
						</label>
						<input
							id="campaign-currency"
							type="text"
							value={currency}
							onChange={(e) => setCurrency(e.target.value.toUpperCase())}
							className={`mt-1 ${inputClass}`}
						/>
					</div>

					{/* Dates */}
					<div className="grid grid-cols-2 gap-3">
						<div>
							<label
								htmlFor="campaign-start"
								className="text-xs font-medium text-muted-foreground"
							>
								Start Date
							</label>
							<input
								id="campaign-start"
								type="date"
								value={startDate}
								onChange={(e) => setStartDate(e.target.value)}
								className={`mt-1 ${inputClass}`}
							/>
						</div>
						<div>
							<label
								htmlFor="campaign-end"
								className="text-xs font-medium text-muted-foreground"
							>
								End Date
							</label>
							<input
								id="campaign-end"
								type="date"
								value={endDate}
								onChange={(e) => setEndDate(e.target.value)}
								className={`mt-1 ${inputClass}`}
							/>
						</div>
					</div>

					{/* Error */}
					{(error || createMutation.error) && (
						<div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
							{error || createMutation.error}
						</div>
					)}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onOpenChange(false)}
						disabled={createMutation.loading}
					>
						Cancel
					</Button>
					<Button
						type="button"
						size="sm"
						onClick={handleSubmit}
						disabled={
							createMutation.loading ||
							!adAccountId ||
							!name.trim() ||
							capability?.state !== "supported"
						}
					>
						{createMutation.loading ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							"Create Campaign"
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
