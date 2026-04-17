import { useEffect, useRef } from "react";

interface Options {
	dirty: boolean;
	onSave: () => Promise<void> | void;
	debounceMs?: number;
	enabled?: boolean;
}

export function useAutosave({
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
	}, [dirty, debounceMs, enabled]);
}
