import { source } from "@/lib/source";
import { generateLLMIndex } from "@/lib/llm-text";

export const revalidate = false;

export function GET() {
  const pages = source.getPages().map((page) => ({
    title: page.data.title,
    description: page.data.description,
    url: page.url,
  }));

  return new Response(generateLLMIndex(pages), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
