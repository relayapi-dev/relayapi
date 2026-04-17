import { useCallback, useEffect, useRef, useState } from "react";
import type { AutomationEdgeSpec, AutomationNodeSpec } from "./types";

export interface GraphSnapshot {
	nodes: AutomationNodeSpec[];
	edges: AutomationEdgeSpec[];
}

interface UseHistoryResult {
	push: (snapshot: GraphSnapshot) => void;
	reset: (snapshot: GraphSnapshot) => void;
	undo: () => GraphSnapshot | null;
	redo: () => GraphSnapshot | null;
	canUndo: boolean;
	canRedo: boolean;
	_version: number;
}

const MAX_HISTORY = 50;

function snapshotsEqual(a: GraphSnapshot, b: GraphSnapshot): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function useHistory(
	onRestore: (snapshot: GraphSnapshot) => void,
): UseHistoryResult {
	const pastRef = useRef<GraphSnapshot[]>([]);
	const futureRef = useRef<GraphSnapshot[]>([]);
	const currentRef = useRef<GraphSnapshot | null>(null);
	const suppressNextPushRef = useRef(false);

	const [version, setVersion] = useState(0);

	const push = useCallback((snapshot: GraphSnapshot) => {
		if (suppressNextPushRef.current) {
			suppressNextPushRef.current = false;
			currentRef.current = snapshot;
			return;
		}
		if (currentRef.current && snapshotsEqual(currentRef.current, snapshot)) {
			return;
		}
		if (currentRef.current) {
			pastRef.current.push(currentRef.current);
			if (pastRef.current.length > MAX_HISTORY) pastRef.current.shift();
		}
		futureRef.current = [];
		currentRef.current = snapshot;
		setVersion((v) => v + 1);
	}, []);

	const reset = useCallback((snapshot: GraphSnapshot) => {
		pastRef.current = [];
		futureRef.current = [];
		currentRef.current = snapshot;
		suppressNextPushRef.current = false;
		setVersion((v) => v + 1);
	}, []);

	const undo = useCallback((): GraphSnapshot | null => {
		const past = pastRef.current;
		if (past.length === 0) return null;
		const previous = past.pop()!;
		if (currentRef.current) futureRef.current.push(currentRef.current);
		currentRef.current = previous;
		suppressNextPushRef.current = true;
		onRestore(previous);
		setVersion((v) => v + 1);
		return previous;
	}, [onRestore]);

	const redo = useCallback((): GraphSnapshot | null => {
		const future = futureRef.current;
		if (future.length === 0) return null;
		const next = future.pop()!;
		if (currentRef.current) pastRef.current.push(currentRef.current);
		currentRef.current = next;
		suppressNextPushRef.current = true;
		onRestore(next);
		setVersion((v) => v + 1);
		return next;
	}, [onRestore]);

	return {
		push,
		reset,
		undo,
		redo,
		canUndo: pastRef.current.length > 0,
		canRedo: futureRef.current.length > 0,
		// force consumers to re-render when the stack changes
		_version: version,
	};
}

export function useHistoryKeyboardShortcuts(
	undo: () => void,
	redo: () => void,
) {
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey)) return;
			const target = e.target as HTMLElement | null;
			const tag = target?.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
				return;
			}
			if (e.key.toLowerCase() === "z" && e.shiftKey) {
				e.preventDefault();
				redo();
			} else if (e.key.toLowerCase() === "z") {
				e.preventDefault();
				undo();
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [undo, redo]);
}
