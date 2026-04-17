import { useEffect, useRef } from "react";

interface Options {
	/** Opaque token that changes on every edit. Use a monotonically increasing
	 *  counter or a content hash — anything stable under "no change" and distinct
	 *  under any change. */
	version: number | string;
	/** Whether the document has unsaved changes right now. */
	dirty: boolean;
	/** Saves the current draft. */
	onSave: () => Promise<void> | void;
	debounceMs?: number;
	enabled?: boolean;
}

/**
 * Debounced autosave safe against "user kept editing while save was in flight":
 *
 * - Re-arms the timer on every `version` change so we save ~debounceMs after
 *   the *latest* edit, not the first one.
 * - When the timer fires while another save is in progress, waits a short
 *   retry interval and checks again instead of dropping the save silently —
 *   otherwise the latest draft could sit unsaved until the next edit.
 */
export function useAutosave({
	version,
	dirty,
	onSave,
	debounceMs = 10_000,
	enabled = true,
}: Options) {
	const savingRef = useRef(false);
	const onSaveRef = useRef(onSave);

	useEffect(() => {
		onSaveRef.current = onSave;
	}, [onSave]);

	useEffect(() => {
		if (!enabled || !dirty) return;
		let cancelled = false;
		let timerId: number | undefined;

		const attempt = async () => {
			if (cancelled) return;
			if (savingRef.current) {
				// Another save is running. Wait a beat and check again so the
				// latest draft gets flushed once the previous save lands.
				timerId = window.setTimeout(attempt, 500);
				return;
			}
			savingRef.current = true;
			try {
				await onSaveRef.current();
			} finally {
				savingRef.current = false;
			}
		};

		timerId = window.setTimeout(attempt, debounceMs);

		return () => {
			cancelled = true;
			if (timerId !== undefined) window.clearTimeout(timerId);
		};
	}, [version, dirty, debounceMs, enabled]);
}
