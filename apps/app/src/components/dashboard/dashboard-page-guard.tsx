import { useState, type ReactNode } from "react";
import { Key, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDashboardApiKeyStatus } from "@/hooks/use-dashboard-api-key-status";
import { useUser } from "./user-context";

function BootstrapKeyBanner() {
	const [creating, setCreating] = useState(false);
	const [done, setDone] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleCreate = async () => {
		setCreating(true);
		setError(null);
		try {
			const res = await fetch("/api/bootstrap-key", { method: "POST" });
			if (res.ok) {
				setDone(true);
				setTimeout(() => window.location.reload(), 500);
			} else {
				const data = await res.json().catch(() => null);
				setError(data?.error || "Failed to create API key");
			}
		} catch {
			setError("Network error");
		} finally {
			setCreating(false);
		}
	};

	if (done) {
		return (
			<div className="flex items-center justify-center py-20">
				<Loader2 className="size-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	return (
		<div className="flex items-center justify-center py-20">
			<div className="max-w-sm text-center">
				<div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/10">
					<Key className="size-6 text-primary" />
				</div>
				<h2 className="text-lg font-medium">Set up API access</h2>
				<p className="mt-2 text-sm text-muted-foreground">
					Your dashboard needs an API key to display data. Click below to
					create one automatically.
				</p>
				{error && <p className="mt-3 text-sm text-destructive">{error}</p>}
				<Button className="mt-4 gap-2" onClick={handleCreate} disabled={creating}>
					{creating ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<Key className="size-4" />
					)}
					{creating ? "Creating..." : "Create Dashboard Key"}
				</Button>
			</div>
		</div>
	);
}

function AccessDenied() {
	return (
		<div className="flex items-center justify-center py-20">
			<div className="max-w-sm text-center">
				<div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-destructive/10">
					<ShieldAlert className="size-6 text-destructive" />
				</div>
				<h2 className="text-lg font-medium">Access Denied</h2>
				<p className="mt-2 text-sm text-muted-foreground">
					You don&apos;t have permission to access this page.
				</p>
			</div>
		</div>
	);
}

export function DashboardPageGuard({
	adminOnly = false,
	children,
	requiresApiKey = true,
}: {
	adminOnly?: boolean;
	children: ReactNode;
	requiresApiKey?: boolean;
}) {
	const user = useUser();
	const { hasApiKey, loading } = useDashboardApiKeyStatus(requiresApiKey);

	if (adminOnly && user?.role !== "admin") {
		return <AccessDenied />;
	}

	if (!requiresApiKey) {
		return <>{children}</>;
	}

	if (!loading && hasApiKey === false) {
		return <BootstrapKeyBanner />;
	}

	return <>{children}</>;
}
