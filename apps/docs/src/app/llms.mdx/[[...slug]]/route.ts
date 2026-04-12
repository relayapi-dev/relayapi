import { generateApiPageContent } from "@/lib/llm-text";
import { source } from "@/lib/source";
import { notFound } from "next/navigation";
import fs from "node:fs/promises";

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

		if (page.absolutePath) {
			const raw = await fs.readFile(page.absolutePath, "utf-8");
			const match = raw.match(/^---[\s\S]*?---\n*/);
			const content = match ? raw.slice(match[0].length) : raw;
			lines.push(content);
		}
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
