import { CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	platformAvatars,
	platformColors,
	platformLabels,
} from "@/lib/platform-maps";
import { cn } from "@/lib/utils";

type CredentialPlatform =
	| "discord"
	| "sms"
	| "whatsapp"
	| "slack"
	| "beehiiv"
	| "convertkit"
	| "mailchimp"
	| "listmonk";

const connectionDescriptions: Record<CredentialPlatform, string> = {
	discord: "Use a channel-bound Incoming Webhook URL",
	slack: "Use a channel-bound Slack Incoming Webhook URL",
	sms: "Use your Twilio account and an owned SMS sender",
	whatsapp: "Use a System User token and the exact WABA phone number",
	beehiiv: "Use an API key and the exact publication ID",
	convertkit: "Use a Kit API v4 key",
	mailchimp: "Use an API key with its datacenter suffix",
	listmonk: "Use a public HTTPS instance URL and admin credentials",
};

interface CredentialDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConnected: () => void;
	platform: CredentialPlatform;
	workspaceId?: string;
}

export function CredentialDialog({
	open,
	onOpenChange,
	onConnected,
	platform,
	workspaceId,
}: CredentialDialogProps) {
	const [webhookUrl, setWebhookUrl] = useState("");
	const [accountSid, setAccountSid] = useState("");
	const [authToken, setAuthToken] = useState("");
	const [fromNumber, setFromNumber] = useState("");
	const [wabaId, setWabaId] = useState("");
	const [phoneNumberId, setPhoneNumberId] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [publicationId, setPublicationId] = useState("");
	const [instanceUrl, setInstanceUrl] = useState("");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	const canSubmit = (() => {
		switch (platform) {
			case "discord":
			case "slack":
				return webhookUrl.trim().length > 0;
			case "sms":
				return Boolean(
					accountSid.trim() && authToken.trim() && fromNumber.trim(),
				);
			case "whatsapp":
				return Boolean(
					authToken.trim() && wabaId.trim() && phoneNumberId.trim(),
				);
			case "beehiiv":
				return Boolean(apiKey.trim() && publicationId.trim());
			case "convertkit":
			case "mailchimp":
				return apiKey.trim().length > 0;
			case "listmonk":
				return Boolean(instanceUrl.trim() && username.trim() && password);
		}
	})();

	const reset = () => {
		setWebhookUrl("");
		setAccountSid("");
		setAuthToken("");
		setFromNumber("");
		setWabaId("");
		setPhoneNumberId("");
		setApiKey("");
		setPublicationId("");
		setInstanceUrl("");
		setUsername("");
		setPassword("");
		setError(null);
		setSuccess(false);
	};

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!canSubmit) return;
		setLoading(true);
		setError(null);
		try {
			let body: Record<string, string>;
			switch (platform) {
				case "discord":
				case "slack":
					body = { webhook_url: webhookUrl.trim() };
					break;
				case "sms":
					body = {
						account_sid: accountSid.trim(),
						auth_token: authToken.trim(),
						from_number: fromNumber.trim(),
					};
					break;
				case "whatsapp":
					body = {
						access_token: authToken.trim(),
						waba_id: wabaId.trim(),
						phone_number_id: phoneNumberId.trim(),
					};
					break;
				case "beehiiv":
					body = {
						api_key: apiKey.trim(),
						publication_id: publicationId.trim(),
					};
					break;
				case "convertkit":
				case "mailchimp":
					body = { api_key: apiKey.trim() };
					break;
				case "listmonk":
					body = {
						instance_url: instanceUrl.trim(),
						username: username.trim(),
						password,
					};
					break;
			}
			const endpoint =
				platform === "whatsapp"
					? "/api/connect/whatsapp"
					: `/api/connect/${platform}/credentials`;
			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...body,
					...(workspaceId ? { workspace_id: workspaceId } : {}),
				}),
			});
			if (!response.ok) {
				const payload = await response.json().catch(() => null);
				setError(
					payload?.error?.message ?? `Connection failed (${response.status})`,
				);
				return;
			}
			setSuccess(true);
			onConnected();
			setTimeout(() => {
				onOpenChange(false);
				reset();
			}, 1_200);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Connection failed");
		} finally {
			setLoading(false);
		}
	};

	const handleOpenChange = (next: boolean) => {
		if (loading) return;
		onOpenChange(next);
		if (!next) reset();
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<div className="flex items-center gap-3">
						<div
							className={cn(
								"flex size-9 items-center justify-center rounded-md text-xs font-bold text-white",
								platformColors[platform],
							)}
						>
							{platformAvatars[platform]}
						</div>
						<div>
							<DialogTitle className="text-base">
								Connect {platformLabels[platform]}
							</DialogTitle>
							<DialogDescription className="text-xs">
								{connectionDescriptions[platform]}
							</DialogDescription>
						</div>
					</div>
				</DialogHeader>

				{success ? (
					<div className="flex flex-col items-center gap-3 py-6">
						<CheckCircle2 className="size-8 text-emerald-500" />
						<p className="text-sm font-medium">
							{platformLabels[platform]} connected!
						</p>
					</div>
				) : (
					<form onSubmit={handleSubmit}>
						<div className="space-y-3 py-2">
							{platform === "discord" || platform === "slack" ? (
								<label className="block text-xs font-medium text-muted-foreground">
									Incoming Webhook URL
									<input
										type="password"
										value={webhookUrl}
										onChange={(event) => setWebhookUrl(event.target.value)}
										placeholder={
											platform === "slack"
												? "https://hooks.slack.com/services/..."
												: "https://discord.com/api/webhooks/..."
										}
										autoComplete="off"
										disabled={loading}
										className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
									/>
								</label>
							) : platform === "sms" ? (
								<>
									<label className="block text-xs font-medium text-muted-foreground">
										Account SID
										<input
											type="text"
											value={accountSid}
											onChange={(event) => setAccountSid(event.target.value)}
											placeholder="AC..."
											autoComplete="off"
											disabled={loading}
											className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
										/>
									</label>
									<label className="block text-xs font-medium text-muted-foreground">
										Auth Token
										<input
											type="password"
											value={authToken}
											onChange={(event) => setAuthToken(event.target.value)}
											autoComplete="off"
											disabled={loading}
											className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
										/>
									</label>
									<label className="block text-xs font-medium text-muted-foreground">
										Default sender
										<input
											type="tel"
											value={fromNumber}
											onChange={(event) => setFromNumber(event.target.value)}
											placeholder="+14155551234"
											autoComplete="tel"
											disabled={loading}
											className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
										/>
									</label>
								</>
							) : platform === "whatsapp" ? (
								<>
									<label className="block text-xs font-medium text-muted-foreground">
										System User access token
										<input
											type="password"
											value={authToken}
											onChange={(event) => setAuthToken(event.target.value)}
											autoComplete="off"
											disabled={loading}
											className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
										/>
									</label>
									<label className="block text-xs font-medium text-muted-foreground">
										WhatsApp Business Account ID
										<input
											type="text"
											value={wabaId}
											onChange={(event) => setWabaId(event.target.value)}
											autoComplete="off"
											disabled={loading}
											className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
										/>
									</label>
									<label className="block text-xs font-medium text-muted-foreground">
										Phone Number ID
										<input
											type="text"
											value={phoneNumberId}
											onChange={(event) => setPhoneNumberId(event.target.value)}
											autoComplete="off"
											disabled={loading}
											className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
										/>
									</label>
								</>
							) : platform === "listmonk" ? (
								<>
									<label className="block text-xs font-medium text-muted-foreground">
										Instance URL
										<input
											type="url"
											value={instanceUrl}
											onChange={(event) => setInstanceUrl(event.target.value)}
											placeholder="https://listmonk.example.com"
											autoComplete="url"
											disabled={loading}
											className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
										/>
									</label>
									<label className="block text-xs font-medium text-muted-foreground">
										Admin username
										<input
											type="text"
											value={username}
											onChange={(event) => setUsername(event.target.value)}
											autoComplete="username"
											disabled={loading}
											className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
										/>
									</label>
									<label className="block text-xs font-medium text-muted-foreground">
										Admin password
										<input
											type="password"
											value={password}
											onChange={(event) => setPassword(event.target.value)}
											autoComplete="current-password"
											disabled={loading}
											className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
										/>
									</label>
								</>
							) : (
								<>
									<label className="block text-xs font-medium text-muted-foreground">
										API key
										<input
											type="password"
											value={apiKey}
											onChange={(event) => setApiKey(event.target.value)}
											placeholder={
												platform === "mailchimp" ? "key-us21" : undefined
											}
											autoComplete="off"
											disabled={loading}
											className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
										/>
									</label>
									{platform === "beehiiv" && (
										<label className="block text-xs font-medium text-muted-foreground">
											Publication ID
											<input
												type="text"
												value={publicationId}
												onChange={(event) =>
													setPublicationId(event.target.value)
												}
												placeholder="pub_..."
												autoComplete="off"
												disabled={loading}
												className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
											/>
										</label>
									)}
								</>
							)}
							{error && (
								<div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
									{error}
								</div>
							)}
						</div>
						<DialogFooter className="mt-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => handleOpenChange(false)}
								disabled={loading}
							>
								Cancel
							</Button>
							<Button type="submit" size="sm" disabled={loading || !canSubmit}>
								{loading ? (
									<Loader2 className="size-3.5 animate-spin" />
								) : (
									"Connect"
								)}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
