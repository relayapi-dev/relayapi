export const revalidate = false;

export function GET() {
  return Response.redirect("https://api.relayapi.dev/openapi.json", 301);
}
