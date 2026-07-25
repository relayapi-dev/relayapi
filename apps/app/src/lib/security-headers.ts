const apiOrigin = new URL(
	import.meta.env.API_BASE_URL || "https://api.relayapi.dev",
).origin;
const websocketOrigin = apiOrigin
	.replace(/^https:/, "wss:")
	.replace(/^http:/, "ws:");
const r2UploadOrigin =
	"https://3496f40fcd55a91da50ded8abea2cf7a.r2.cloudflarestorage.com";

const APP_CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"base-uri 'self'",
	"frame-ancestors 'none'",
	"form-action 'self'",
	"object-src 'none'",
	"script-src 'self' 'unsafe-inline'",
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
	"font-src 'self' data: https://fonts.gstatic.com",
	"img-src 'self' data: blob: https:",
	"media-src 'self' blob: https:",
	`connect-src 'self' ${apiOrigin} ${websocketOrigin} ${r2UploadOrigin}`,
	"worker-src 'self' blob:",
	"upgrade-insecure-requests",
].join("; ");

export function applyAppSecurityHeaders(
	response: Response,
	isProduction: boolean,
): Response {
	response.headers.delete("X-Powered-By");
	response.headers.set("X-Content-Type-Options", "nosniff");
	response.headers.set("X-Frame-Options", "DENY");
	response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
	response.headers.set(
		"Permissions-Policy",
		"camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	);
	if (isProduction) {
		response.headers.set(
			"Strict-Transport-Security",
			"max-age=31536000; includeSubDomains",
		);
		response.headers.set(
			"Content-Security-Policy",
			APP_CONTENT_SECURITY_POLICY,
		);
	}
	return response;
}
