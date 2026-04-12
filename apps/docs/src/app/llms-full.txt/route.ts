import { generateLLMText } from "@/lib/llm-text";
import { source } from "@/lib/source";
import fs from "node:fs/promises";

export const revalidate = false;

export async function GET() {
	const pages = source.getPages();
	const sections = await Promise.all(
		pages.map(async (page) => {
			const isApiPage = !!page.data.full;
			let content: string | undefined;

			if (!isApiPage && page.absolutePath) {
				const raw = await fs.readFile(page.absolutePath, "utf-8");
				const match = raw.match(/^---[\s\S]*?---\n*/);
				content = match ? raw.slice(match[0].length) : raw;
			}

			return generateLLMText(
				page.data.title,
				page.data.description,
				page.url,
				isApiPage,
				content,
			);
		}),
	);

	return new Response(sections.join("\n\n---\n\n"), {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
}
