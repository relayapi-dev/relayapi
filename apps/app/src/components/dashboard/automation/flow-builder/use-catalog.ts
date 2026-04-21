// Catalog hook (Plan 2 — Unit K2).
//
// Fetches the static automation catalog (node kinds, entrypoint kinds, binding
// types, action types, channel capabilities, template kinds) from the
// dashboard proxy at `/api/automations/catalog`, which in turn calls the SDK's
// `client.automations.catalog()`.
//
// The catalog is effectively static across an API deploy, so we cache the
// last successful response in sessionStorage for one hour. On render we
// optimistically hydrate from the cache, then re-fetch in the background.

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CatalogNodeKind {
	kind: string;
	label: string;
	category: string;
	description: string;
	[extra: string]: unknown;
}

export interface CatalogEntrypointKind {
	kind: string;
	label: string;
	channels: string[];
	[extra: string]: unknown;
}

export interface CatalogBindingType {
	type: string;
	label: string;
	channels: string[];
	v1_status: "wired" | "stubbed";
	[extra: string]: unknown;
}

export interface CatalogActionType {
	type: string;
	label: string;
	category: string;
	[extra: string]: unknown;
}

export type ChannelCapabilities = Record<string, Record<string, boolean>>;

export interface AutomationCatalog {
	node_kinds: CatalogNodeKind[];
	entrypoint_kinds: CatalogEntrypointKind[];
	binding_types: CatalogBindingType[];
	action_types: CatalogActionType[];
	channel_capabilities: ChannelCapabilities;
	template_kinds: string[];
}

interface CacheEnvelope {
	timestamp: number;
	data: AutomationCatalog;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_KEY = "relayapi:automation:catalog:v1";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

function readCache(): AutomationCatalog | null {
	if (typeof window === "undefined") return null;
	try {
		const raw = window.sessionStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as CacheEnvelope;
		if (!parsed.timestamp || Date.now() - parsed.timestamp > CACHE_TTL_MS) {
			window.sessionStorage.removeItem(CACHE_KEY);
			return null;
		}
		return parsed.data;
	} catch {
		return null;
	}
}

function writeCache(data: AutomationCatalog) {
	if (typeof window === "undefined") return;
	try {
		window.sessionStorage.setItem(
			CACHE_KEY,
			JSON.stringify({ timestamp: Date.now(), data }),
		);
	} catch {
		// Storage quota / private mode — ignore.
	}
}

// ---------------------------------------------------------------------------
// In-flight dedupe — share a single fetch across all simultaneous mounts.
// ---------------------------------------------------------------------------

let inflight: Promise<AutomationCatalog> | null = null;

async function fetchCatalog(): Promise<AutomationCatalog> {
	if (inflight) return inflight;
	inflight = (async () => {
		const res = await fetch("/api/automations/catalog", {
			credentials: "same-origin",
		});
		if (!res.ok) {
			let message = `Failed to load catalog (HTTP ${res.status})`;
			try {
				const body = (await res.json()) as {
					error?: { message?: string };
				};
				if (body?.error?.message) message = body.error.message;
			} catch {
				// non-JSON error — keep default message
			}
			throw new Error(message);
		}
		const data = (await res.json()) as AutomationCatalog;
		writeCache(data);
		return data;
	})();
	try {
		return await inflight;
	} finally {
		inflight = null;
	}
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseAutomationCatalogResult {
	data: AutomationCatalog | undefined;
	isLoading: boolean;
	error: unknown;
	refetch: () => void;
}

export function useAutomationCatalog(): UseAutomationCatalogResult {
	const [data, setData] = useState<AutomationCatalog | undefined>(() => {
		const cached = readCache();
		return cached ?? undefined;
	});
	const [isLoading, setIsLoading] = useState<boolean>(() => readCache() === null);
	const [error, setError] = useState<unknown>(null);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const load = useCallback(async (background: boolean) => {
		if (!background) setIsLoading(true);
		setError(null);
		try {
			const fresh = await fetchCatalog();
			if (!mountedRef.current) return;
			setData(fresh);
		} catch (err) {
			if (!mountedRef.current) return;
			// On background failures, prefer the stale cached value (which is
			// already in `data`) rather than blanking the UI.
			setError(err);
		} finally {
			if (mountedRef.current) setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		const cached = readCache();
		if (cached) {
			// Have a cached copy → serve immediately, refresh quietly.
			void load(true);
		} else {
			void load(false);
		}
	}, [load]);

	const refetch = useCallback(() => {
		void load(true);
	}, [load]);

	return { data, isLoading, error, refetch };
}

// Exposed for tests / reset on logout.
export function clearAutomationCatalogCache() {
	if (typeof window !== "undefined") {
		try {
			window.sessionStorage.removeItem(CACHE_KEY);
		} catch {
			// ignore
		}
	}
	inflight = null;
}
