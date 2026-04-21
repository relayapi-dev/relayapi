// segment_add / segment_remove form.
//
// Fetches segments from `/api/segments` and lets the user pick one. Falls
// back to free-text entry if the list fails to load.

import { useEffect, useState } from "react";
import type { SegmentAddAction, SegmentRemoveAction } from "../types";
import { Field, FormShell, INPUT_CLS } from "./shared";

interface SegmentRow {
	id: string;
	name: string;
}

interface ListResponse {
	data: SegmentRow[];
}

type Props = {
	action: SegmentAddAction | SegmentRemoveAction;
	onChange(next: SegmentAddAction | SegmentRemoveAction): void;
	error?: string | null;
};

export function SegmentActionForm({ action, onChange, error }: Props) {
	const [segments, setSegments] = useState<SegmentRow[]>([]);
	const [loadFailed, setLoadFailed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch("/api/segments?limit=100");
				if (!res.ok) {
					if (!cancelled) setLoadFailed(true);
					return;
				}
				const body = (await res.json()) as ListResponse;
				if (!cancelled && Array.isArray(body.data)) setSegments(body.data);
			} catch {
				if (!cancelled) setLoadFailed(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<FormShell>
			<Field
				label="Segment"
				required
				description={
					loadFailed
						? "Segment list failed to load — paste the segment ID manually."
						: "Pick a segment from your workspace."
				}
				error={error}
			>
				{segments.length > 0 ? (
					<select
						value={action.segment_id}
						onChange={(e) =>
							onChange({ ...action, segment_id: e.target.value })
						}
						className={INPUT_CLS}
					>
						<option value="">Select a segment…</option>
						{segments.map((s) => (
							<option key={s.id} value={s.id}>
								{s.name}
							</option>
						))}
					</select>
				) : (
					<input
						type="text"
						value={action.segment_id}
						onChange={(e) =>
							onChange({ ...action, segment_id: e.target.value })
						}
						placeholder="seg_..."
						className={INPUT_CLS}
					/>
				)}
			</Field>
		</FormShell>
	);
}
