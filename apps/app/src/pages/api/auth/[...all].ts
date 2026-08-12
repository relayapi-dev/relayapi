import type { APIRoute } from "astro";
import { mapAuthDatabaseError } from "../../../lib/auth-database-error";

export const ALL: APIRoute = async (context) => {
	const auth = context.locals.auth;
	try {
		return await auth.handler(context.request);
	} catch (error) {
		const mapped = mapAuthDatabaseError(error);
		if (mapped) return mapped;
		throw error;
	}
};

export const GET = ALL;
export const POST = ALL;
