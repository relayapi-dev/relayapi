import { defineDocs, defineConfig } from "fumadocs-mdx/config";
import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";

export const docs = defineDocs({
  dir: "content/docs",
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
