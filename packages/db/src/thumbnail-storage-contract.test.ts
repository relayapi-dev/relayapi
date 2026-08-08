/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { externalPosts, media } from "./schema";

test("durable thumbnails pin a complete physical locator beside every key", () => {
	const mediaConfig = getTableConfig(media);
	expect(mediaConfig.columns.map(({ name }) => name)).toEqual(
		expect.arrayContaining([
			"thumbnail_key",
			"thumbnail_storage_provider",
			"thumbnail_storage_bucket_locator",
			"thumbnail_storage_region",
		]),
	);
	expect(mediaConfig.checks.map(({ name }) => name)).toEqual(
		expect.arrayContaining([
			"media_thumbnail_storage_locator_check",
			"media_thumbnail_projection_check",
		]),
	);

	const externalConfig = getTableConfig(externalPosts);
	expect(externalConfig.columns.map(({ name }) => name)).toEqual(
		expect.arrayContaining([
			"preview_thumbnail_key",
			"preview_storage_provider",
			"preview_storage_bucket_locator",
			"preview_storage_region",
		]),
	);
	expect(externalConfig.checks.map(({ name }) => name)).toEqual(
		expect.arrayContaining([
			"external_posts_preview_storage_locator_check",
			"external_posts_preview_projection_check",
		]),
	);
});
