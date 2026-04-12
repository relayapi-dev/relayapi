import { Loader2 } from "lucide-react";

interface LoadMoreProps {
	hasMore: boolean;
	loading: boolean;
	onLoadMore: () => void;
	count: number;
}

export function LoadMore({
	hasMore,
	loading,
	onLoadMore,
	count,
}: LoadMoreProps) {
	if (!hasMore) return null;

	return (
		<div className="flex items-center justify-center pt-2">
			{hasMore && (
				<button
					onClick={onLoadMore}
					disabled={loading}
					className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent/50 transition-colors disabled:opacity-50"
				>
					{loading ? (
						<>
							<Loader2 className="size-3 animate-spin" />
							Loading...
						</>
					) : (
						"Load more"
					)}
				</button>
			)}
		</div>
	);
}
