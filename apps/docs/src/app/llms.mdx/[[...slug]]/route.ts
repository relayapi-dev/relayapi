import { generateApiPageContent } from "@/lib/llm-text";
import { source } from "@/lib/source";
import { notFound } from "next/navigation";

export const revalidate = false;

export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ slug?: string[] }> },
) {
	const { slug } = await params;
	const page = source.getPage(slug);
	if (!page) notFound();

	const isApiPage = !!page.data.full;

	const lines: string[] = [];
	lines.push(`# ${page.data.title}`);
	lines.push("");

	if (isApiPage) {
		lines.push(await generateApiPageContent(page));
	} else {
		if (page.data.description) {
			lines.push(page.data.description);
			lines.push("");
		}
		lines.push(`Documentation: https://docs.relayapi.dev${page.url}`);
		lines.push("");

		// Processed Markdown is bundled into the page module (see
		// source.config.ts `includeProcessedMarkdown`), so this works at runtime
		// on Cloudflare Workers — unlike reading the source file from disk.
		lines.push(await page.data.getText("processed"));
	}

	return new Response(lines.join("\n").trim(), {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
		},
	});
}

export function generateStaticParams() {
	return source.generateParams();
}
