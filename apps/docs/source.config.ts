import { defineDocs, defineConfig } from "fumadocs-mdx/config";
import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // Bundle the processed Markdown into each page module so
    // `page.data.getText("processed")` works at runtime on Cloudflare Workers
    // (which have no filesystem). This powers the LLM/Markdown routes
    // (/llms-full.txt, /{slug}.mdx) and the "Copy for AI" button — using
    // getText("raw") or fs.readFile there 500s in the Worker.
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      ...rehypeCodeDefaultOptions,
      langs: [
        "bash",
        "shell",
        "typescript",
        "javascript",
        "json",
        "yaml",
        "python",
        "go",
        "java",
        "csharp",
        "http",
      ],
    },
  },
});
