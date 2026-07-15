"use client";
import type { MediaAdapter } from "fumadocs-openapi";
import { createOpenAPIPage } from "fumadocs-openapi/ui";

const binaryMediaAdapter: MediaAdapter = {
	encode: ({ body }) => body as BodyInit,
	generateExample: () => undefined,
};

const binaryMediaTypes = [
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/heic",
	"image/heif",
	"image/avif",
	"video/mp4",
	"video/webm",
	"video/quicktime",
	"video/mpeg",
	"audio/mpeg",
	"audio/mp4",
	"audio/webm",
	"audio/wav",
	"audio/ogg",
	"application/pdf",
] as const;

export const APIPage = createOpenAPIPage({
	mediaAdapters: Object.fromEntries(
		binaryMediaTypes.map((mediaType) => [mediaType, binaryMediaAdapter]),
	),
});
