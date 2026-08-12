import { Container } from "@cloudflare/containers";

const CONTAINER_PORT = 8080;
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

/**
 * Private streaming boundary for the ffmpeg media container. No public route
 * reaches this Durable Object; Workflows use the generated namespace binding.
 */
export class MediaProcessorContainer extends Container {
	defaultPort = CONTAINER_PORT;
	sleepAfter = "2m";
	enableInternet = false;

	override async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST" || new URL(request.url).pathname !== "/transform") {
			return new Response("Not found", { status: 404 });
		}
		if (!request.body) return new Response("Missing media body", { status: 400 });
		const declared = Number(request.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
			void request.body.cancel().catch(() => {});
			return new Response("Input exceeds 200 MiB", { status: 413 });
		}
		const headers = new Headers();
		for (const name of [
			"content-type",
			"content-length",
			"x-relay-media-operation",
			"x-relay-media-profile",
			"x-relay-media-options",
		]) {
			const value = request.headers.get(name);
			if (value !== null) headers.set(name, value);
		}
		return this.containerFetch(
			new Request("http://media-processor/transform", {
				method: "POST",
				headers,
				body: request.body,
			}),
		);
	}
}
