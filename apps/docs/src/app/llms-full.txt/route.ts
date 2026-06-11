import { generateLLMText } from "@/lib/llm-text";
import { source } from "@/lib/source";

export const revalidate = false;

export async function GET() {
	const pages = source.getPages();
	const sections = await Promise.all(
		pages.map(async (page) => {
			const isApiPage = !!page.data.full;
			let content: string | undefined;

			if (!isApiPage) {
				// Processed Markdown is bundled into the page module (see
				// source.config.ts `includeProcessedMarkdown`), so this works at
				// runtime on Cloudflare Workers — unlike reading from disk.
				content = await page.data.getText("processed");
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
