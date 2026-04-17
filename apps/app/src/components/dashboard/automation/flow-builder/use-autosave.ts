import { useEffect, useRef } from "react";

interface Options {
	/** Opaque token that changes on every edit. Use a monotonically increasing
	 *  counter or a content hash — anything stable under "no change" and distinct
	 *  under any change. */
	version: number | string;
	/** Whether the document has unsaved changes right now. */
	dirty: boolean;
	/** Saves and returns the version token that was persisted. */
	onSave: () => Promise<number | string | void>;
	debounceMs?: number;
	enabled?: boolean;
}

/**
 * Debounced autosave that is safe against "user kept editing while save was
 * in flight": we re-arm the timer on every `version` change, and the caller's
 * onSave returns the version it actually persisted so we don't confuse caller
 * UI by clearing the dirty indicator for a newer edit.
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
		const id = window.setTimeout(async () => {
			if (savingRef.current) return;
			savingRef.current = true;
			try {
				await onSaveRef.current();
			} finally {
				savingRef.current = false;
			}
		}, debounceMs);
		return () => window.clearTimeout(id);
		// `version` is the re-arm trigger: every edit bumps it, which restarts
		// the debounce window so we always save ~debounceMs after the *latest*
		// edit, not the first one.
	}, [version, dirty, debounceMs, enabled]);
}
