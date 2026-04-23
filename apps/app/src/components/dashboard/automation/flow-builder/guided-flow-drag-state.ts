import type { NodeChange, XYPosition } from "reactflow";

export type LiveNodePositions = Record<string, XYPosition>;

export interface CommittedNodePosition {
	id: string;
	position: XYPosition;
}

export function partitionNodePositionChanges(changes: NodeChange[]): {
	live: LiveNodePositions;
	committed: CommittedNodePosition[];
} {
	const live: LiveNodePositions = {};
	const committed: CommittedNodePosition[] = [];

	for (const change of changes) {
		if (change.type !== "position" || !change.position) continue;
		const position = {
			x: change.position.x,
			y: change.position.y,
		};
		if (change.dragging) {
			live[change.id] = position;
			continue;
		}
		delete live[change.id];
		committed.push({ id: change.id, position });
	}

	return { live, committed };
}

export function updateLiveNodePositions(
	current: LiveNodePositions,
	live: LiveNodePositions,
	clearIds: string[],
): LiveNodePositions {
	let next = current;

	for (const [id, position] of Object.entries(live)) {
		const prev = next[id];
		if (prev && prev.x === position.x && prev.y === position.y) continue;
		if (next === current) next = { ...current };
		next[id] = position;
	}

	for (const id of clearIds) {
		if (!(id in next)) continue;
		if (next === current) next = { ...current };
		delete next[id];
	}

	return next;
}
