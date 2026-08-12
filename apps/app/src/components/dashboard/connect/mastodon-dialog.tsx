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
import { platformAvatars, platformColors } from "@/lib/platform-maps";
import { cn } from "@/lib/utils";

interface MastodonDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId?: string;
}

export function MastodonDialog({
	open,
	onOpenChange,
	workspaceId,
}: MastodonDialogProps) {
	const [instanceUrl, setInstanceUrl] = useState("");
	const [error, setError] = useState<string | null>(null);

	const submit = (event: React.FormEvent) => {
		event.preventDefault();
		try {
			const instance = new URL(instanceUrl.trim());
			if (instance.protocol !== "https:") {
				throw new Error("The instance must use HTTPS.");
			}
			const query = new URLSearchParams({ instance_url: instance.origin });
			if (workspaceId) query.set("workspace_id", workspaceId);
			window.location.assign(`/app/connect/start/mastodon?${query.toString()}`);
		} catch (caught) {
			setError(
				caught instanceof Error
					? caught.message
					: "Enter a valid Mastodon instance URL.",
			);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<div className="flex items-center gap-3">
						<div
							className={cn(
								"flex size-9 items-center justify-center rounded-md text-xs font-bold text-white",
								platformColors.mastodon,
							)}
						>
							{platformAvatars.mastodon}
						</div>
						<div>
							<DialogTitle className="text-base">Connect Mastodon</DialogTitle>
							<DialogDescription className="text-xs">
								Enter the home server for your account
							</DialogDescription>
						</div>
					</div>
				</DialogHeader>
				<form onSubmit={submit}>
					<div className="space-y-3 py-2">
						<label className="block text-xs font-medium text-muted-foreground">
							Instance URL
							<input
								type="url"
								value={instanceUrl}
								onChange={(event) => setInstanceUrl(event.target.value)}
								placeholder="https://mastodon.social"
								autoComplete="url"
								className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
							/>
						</label>
						<p className="text-xs text-muted-foreground">
							RelayAPI discovers and registers with this server before opening
							its authorization page.
						</p>
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
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" size="sm" disabled={!instanceUrl.trim()}>
							Continue
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
