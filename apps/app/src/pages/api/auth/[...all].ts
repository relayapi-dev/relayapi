import type { APIRoute } from "astro";

export const ALL: APIRoute = async (context) => {
  const auth = context.locals.auth;
  return auth.handler(context.request);
};

export const GET = ALL;
export const POST = ALL;
