import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const PRODUCTION_DOCS_ORIGIN = "https://docs.relayapi.dev";

/**
 * Next 16's `proxy.ts` is Node-only, which OpenNext Cloudflare does not yet
 * support. Keeping the legacy filename deliberately retains the supported
 * Edge Middleware runtime until that adapter limitation is removed.
 */
export function middleware(request: NextRequest) {
	if (
		process.env.NODE_ENV === "production" &&
		request.nextUrl.protocol === "http:"
	) {
		const secureUrl = `${PRODUCTION_DOCS_ORIGIN}${request.nextUrl.pathname}${request.nextUrl.search}`;
		return NextResponse.redirect(secureUrl, 308);
	}
	return NextResponse.next();
}

export const config = {
	matcher: "/:path*",
};
