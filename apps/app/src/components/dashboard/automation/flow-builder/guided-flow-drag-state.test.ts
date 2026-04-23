import { describe, expect, it } from "bun:test";
import type { NodeChange } from "reactflow";
import {
	partitionNodePositionChanges,
	updateLiveNodePositions,
} from "./guided-flow-drag-state";

describe("partitionNodePositionChanges", () => {
	it("keeps in-flight drag positions separate from committed positions", () => {
		const changes: NodeChange[] = [
			{
				id: "node_live",
				type: "position",
				position: { x: 120, y: 80 },
				positionAbsolute: { x: 120, y: 80 },
				dragging: true,
			},
			{
				id: "node_commit",
				type: "position",
				position: { x: 440, y: 260 },
				positionAbsolute: { x: 440, y: 260 },
				dragging: false,
			},
			{
				id: "node_select",
				type: "select",
				selected: true,
			},
		];

		const result = partitionNodePositionChanges(changes);

		expect(result.live).toEqual({
			node_live: { x: 120, y: 80 },
		});
		expect(result.committed).toEqual([
			{
				id: "node_commit",
				position: { x: 440, y: 260 },
			},
		]);
	});
});

describe("updateLiveNodePositions", () => {
	it("merges live drag positions and clears nodes after drag stop", () => {
		const result = updateLiveNodePositions(
			{
				stale: { x: 10, y: 20 },
				keep: { x: 30, y: 40 },
			},
			{
				keep: { x: 35, y: 45 },
				fresh: { x: 50, y: 60 },
			},
			["stale"],
		);

		expect(result).toEqual({
			keep: { x: 35, y: 45 },
			fresh: { x: 50, y: 60 },
		});
	});

	it("returns the same object when nothing changes", () => {
		const current = {
			node_a: { x: 10, y: 20 },
		};

		const result = updateLiveNodePositions(current, {}, []);

		expect(result).toBe(current);
	});
});
