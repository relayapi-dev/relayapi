import { describe, expect, it } from "bun:test";
import { mapMetaObjectiveToLocal } from "../services/ad-platforms/meta";

describe("meta ad adapter objective normalization", () => {
	it("maps objective-based buying goals to local objectives", () => {
		expect(mapMetaObjectiveToLocal("OUTCOME_TRAFFIC")).toBe("traffic");
		expect(mapMetaObjectiveToLocal("OUTCOME_ENGAGEMENT")).toBe("engagement");
		expect(mapMetaObjectiveToLocal("OUTCOME_SALES")).toBe("conversions");
	});

	it("maps legacy objectives to local objectives", () => {
		expect(mapMetaObjectiveToLocal("LINK_CLICKS")).toBe("traffic");
		expect(mapMetaObjectiveToLocal("LEAD_GENERATION")).toBe("leads");
		expect(mapMetaObjectiveToLocal("VIDEO_VIEWS")).toBe("video_views");
	});

	it("falls back to engagement for unknown objectives", () => {
		expect(mapMetaObjectiveToLocal("SOMETHING_NEW")).toBe("engagement");
		expect(mapMetaObjectiveToLocal()).toBe("engagement");
	});
});
