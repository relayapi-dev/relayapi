import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const PORT = 8080;
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_OPTIONS_BYTES = 8 * 1024;
const MAX_PROCESS_LOG_BYTES = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 9 * 60 * 1000;

class ByteLimit extends Transform {
	constructor(limit) {
		super();
		this.limit = limit;
		this.seen = 0;
		this.hash = createHash("sha256");
	}

	_transform(chunk, _encoding, callback) {
		this.seen += chunk.length;
		this.hash.update(chunk);
		if (this.seen > this.limit) {
			callback(new Error(`stream exceeds ${this.limit} bytes`));
			return;
		}
		callback(null, chunk);
	}
}

function decodeOptions(value) {
	if (!value) return {};
	const encoded = Buffer.from(value, "base64url");
	if (encoded.byteLength > MAX_OPTIONS_BYTES) {
		throw new Error("processing options are too large");
	}
	const parsed = JSON.parse(encoded.toString("utf8"));
	if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
		throw new Error("processing options must be an object");
	}
	return parsed;
}

async function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "ignore", "pipe"],
			env: { PATH: process.env.PATH, TMPDIR: os.tmpdir() },
		});
		const stderr = [];
		let stderrBytes = 0;
		child.stderr.on("data", (chunk) => {
			if (stderrBytes >= MAX_PROCESS_LOG_BYTES) return;
			const retained = chunk.subarray(0, MAX_PROCESS_LOG_BYTES - stderrBytes);
			stderr.push(retained);
			stderrBytes += retained.length;
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), PROCESS_TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve();
				return;
			}
			const detail = Buffer.concat(stderr).toString("utf8").trim();
			reject(
				new Error(
					`${command} failed (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
				),
			);
		});
	});
}

function outputPlan(operation, inputType, options) {
	const compression = options.compression_mode;
	const crf =
		compression === "high_quality"
			? "20"
			: compression === "smaller"
				? "28"
				: "23";
	if (operation === "cover") {
		const timestamp = Number(options.timestamp_seconds ?? 0);
		if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > 86_400) {
			throw new Error("timestamp_seconds must be between 0 and 86400");
		}
		return {
			extension: "jpg",
			mimeType: "image/jpeg",
			args: [
				...(inputType.startsWith("video/") ? ["-ss", String(timestamp)] : []),
				"-i",
				"INPUT",
				"-frames:v",
				"1",
				"-vf",
				"scale=1920:1920:force_original_aspect_ratio=decrease",
				"-q:v",
				"3",
				"-map_metadata",
				"-1",
				"OUTPUT",
			],
		};
	}
	if (inputType === "image/gif") {
		return {
			extension: "mp4",
			mimeType: "video/mp4",
			args: [
				"-i",
				"INPUT",
				"-movflags",
				"+faststart",
				"-pix_fmt",
				"yuv420p",
				"-vf",
				"scale=1920:-2:force_original_aspect_ratio=decrease",
				"-c:v",
				"libx264",
				"-preset",
				"medium",
				"-crf",
				crf,
				"-an",
				"-map_metadata",
				"-1",
				"OUTPUT",
			],
		};
	}
	if (["image/png", "image/webp", "image/avif"].includes(inputType)) {
		return {
			extension: "png",
			mimeType: "image/png",
			args: [
				"-i",
				"INPUT",
				"-frames:v",
				"1",
				"-vf",
				"scale=4096:4096:force_original_aspect_ratio=decrease",
				"-compression_level",
				"9",
				"-map_metadata",
				"-1",
				"OUTPUT",
			],
		};
	}
	if (inputType.startsWith("image/")) {
		return {
			extension: "jpg",
			mimeType: "image/jpeg",
			args: [
				"-i",
				"INPUT",
				"-frames:v",
				"1",
				"-vf",
				"scale=4096:4096:force_original_aspect_ratio=decrease",
				"-q:v",
				compression === "smaller" ? "5" : "3",
				"-map_metadata",
				"-1",
				"OUTPUT",
			],
		};
	}
	if (inputType.startsWith("video/")) {
		return {
			extension: "mp4",
			mimeType: "video/mp4",
			args: [
				"-i",
				"INPUT",
				"-movflags",
				"+faststart",
				"-pix_fmt",
				"yuv420p",
				"-vf",
				"scale=1920:-2:force_original_aspect_ratio=decrease",
				"-c:v",
				"libx264",
				"-preset",
				"medium",
				"-crf",
				crf,
				"-c:a",
				"aac",
				"-b:a",
				"128k",
				"-map_metadata",
				"-1",
				"OUTPUT",
			],
		};
	}
	if (inputType.startsWith("audio/")) {
		return {
			extension: "m4a",
			mimeType: "audio/mp4",
			args: [
				"-i",
				"INPUT",
				"-vn",
				"-c:a",
				"aac",
				"-b:a",
				"128k",
				"-map_metadata",
				"-1",
				"OUTPUT",
			],
		};
	}
	throw new Error(`unsupported processing input type: ${inputType}`);
}

async function probe(outputPath) {
	const child = spawn(
		"ffprobe",
		[
			"-v",
			"error",
			"-show_entries",
			"stream=width,height:format=duration",
			"-of",
			"json",
			outputPath,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const chunks = [];
	const stderr = [];
	let total = 0;
	let stderrBytes = 0;
	child.stderr.on("data", (chunk) => {
		if (stderrBytes >= MAX_PROCESS_LOG_BYTES) return;
		const retained = chunk.subarray(0, MAX_PROCESS_LOG_BYTES - stderrBytes);
		stderr.push(retained);
		stderrBytes += retained.length;
	});
	const completion = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), PROCESS_TIMEOUT_MS);
	try {
		for await (const chunk of child.stdout) {
			total += chunk.length;
			if (total > MAX_PROCESS_LOG_BYTES) {
				child.kill("SIGKILL");
				throw new Error("ffprobe output exceeded its bound");
			}
			chunks.push(chunk);
		}
		const exit = await completion;
		if (exit !== 0) {
			const detail = Buffer.concat(stderr).toString("utf8").trim();
			throw new Error(`ffprobe failed${detail ? `: ${detail}` : ""}`);
		}
	} catch (error) {
		child.kill("SIGKILL");
		await completion.catch(() => {});
		throw error;
	} finally {
		clearTimeout(timer);
	}
	const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	const visual = Array.isArray(parsed.streams)
		? parsed.streams.find(
				(stream) =>
					Number.isFinite(stream.width) || Number.isFinite(stream.height),
			)
		: undefined;
	return {
		width: Number.isFinite(visual?.width) ? Math.trunc(visual.width) : null,
		height: Number.isFinite(visual?.height) ? Math.trunc(visual.height) : null,
		duration: Number.isFinite(Number(parsed.format?.duration))
			? Math.max(0, Math.round(Number(parsed.format.duration)))
			: null,
	};
}

async function sha256File(filename) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filename)) hash.update(chunk);
	return hash.digest("hex");
}

async function transform(request, response) {
	const contentLength = Number(request.headers["content-length"] ?? 0);
	if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
		response.writeHead(413).end("input exceeds 200 MiB");
		return;
	}
	const operation = request.headers["x-relay-media-operation"];
	const profile = request.headers["x-relay-media-profile"];
	const inputType = String(
		request.headers["content-type"] ?? "application/octet-stream",
	)
		.split(";", 1)[0]
		.trim()
		.toLowerCase();
	if (
		!operation ||
		!profile ||
		!["normalize", "provider_variant", "cover"].includes(operation)
	) {
		response.writeHead(400).end("invalid processing request");
		return;
	}

	const directory = await mkdtemp(
		path.join(os.tmpdir(), `relay-${randomUUID()}-`),
	);
	try {
		const options = decodeOptions(request.headers["x-relay-media-options"]);
		const plan = outputPlan(operation, inputType, options);
		const inputPath = path.join(directory, "input.bin");
		const outputPath = path.join(directory, `output.${plan.extension}`);
		const inputLimit = new ByteLimit(MAX_BYTES);
		await pipeline(
			request,
			inputLimit,
			createWriteStream(inputPath, { flags: "wx" }),
		);
		const sourceChecksum = inputLimit.hash.digest("hex");
		const args = plan.args.map((value) =>
			value === "INPUT" ? inputPath : value === "OUTPUT" ? outputPath : value,
		);
		await run("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args]);
		const output = await stat(outputPath);
		if (output.size <= 0 || output.size > MAX_BYTES) {
			throw new Error("processed output has an invalid size");
		}
		const checksum = await sha256File(outputPath);
		const metadata = await probe(outputPath);
		response.writeHead(200, {
			"content-type": plan.mimeType,
			"content-length": String(output.size),
			"x-relay-sha256": checksum,
			"x-relay-source-sha256": sourceChecksum,
			"x-relay-width": metadata.width === null ? "" : String(metadata.width),
			"x-relay-height": metadata.height === null ? "" : String(metadata.height),
			"x-relay-duration":
				metadata.duration === null ? "" : String(metadata.duration),
			"cache-control": "no-store",
		});
		await pipeline(createReadStream(outputPath), response);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

const server = http.createServer((request, response) => {
	if (request.method !== "POST" || request.url !== "/transform") {
		response.writeHead(404).end("not found");
		return;
	}
	transform(request, response).catch((error) => {
		if (response.headersSent) {
			response.destroy(error);
			return;
		}
		response.writeHead(422, { "content-type": "text/plain; charset=utf-8" });
		response.end(
			String(error instanceof Error ? error.message : error).slice(0, 4096),
		);
	});
});

server.requestTimeout = 10 * 60 * 1000;
server.headersTimeout = 30 * 1000;
server.listen(PORT, "0.0.0.0");
