import { source } from "@/lib/source";
import { generateLLMText } from "@/lib/llm-text";
import { notFound } from "next/navigation";

export const revalidate = false;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const text = await generateLLMText(
    page.data.title,
    page.data.description,
    page.url,
    !!page.data.full,
  );

  return new Response(text, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

export function generateStaticParams() {
  return source
    .generateParams()
    .filter((p) => p.slug && p.slug.length > 0);
}
