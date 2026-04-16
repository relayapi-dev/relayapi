type IdleWindow = Window & {
	requestIdleCallback?: (
		callback: IdleRequestCallback,
		options?: IdleRequestOptions,
	) => number;
	cancelIdleCallback?: (handle: number) => void;
};

export function scheduleIdleTask(
	callback: () => void,
	timeout = 1500,
): () => void {
	if (typeof window === "undefined") return () => {};

	const idleWindow = window as IdleWindow;
	if (typeof idleWindow.requestIdleCallback === "function") {
		const handle = idleWindow.requestIdleCallback(() => callback(), {
			timeout,
		});
		return () => idleWindow.cancelIdleCallback?.(handle);
	}

	const handle = window.setTimeout(callback, Math.min(timeout, 250));
	return () => window.clearTimeout(handle);
}

export function scheduleAfterPaint(
	callback: () => void,
	delay = 0,
): () => void {
	if (typeof window === "undefined") return () => {};

	let timeoutHandle: number | null = null;
	const rafHandle = window.requestAnimationFrame(() => {
		timeoutHandle = window.setTimeout(callback, delay);
	});

	return () => {
		window.cancelAnimationFrame(rafHandle);
		if (timeoutHandle !== null) {
			window.clearTimeout(timeoutHandle);
		}
	};
}
