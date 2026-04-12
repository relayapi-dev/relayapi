import { openapi } from "@/lib/openapi";
import { createAPIPage } from "fumadocs-openapi/ui";
import type { ApiPageProps } from "fumadocs-openapi/ui";
import client from "./api-page.client";
import { jsx } from "react/jsx-runtime";

export const APIPage = createAPIPage(openapi, {
  client,
  async renderCodeBlock({ lang, code }) {
    if (typeof code !== "string") return null;

    const { defaultShikiFactory } = await import(
      "fumadocs-core/highlight/shiki/full"
    );
    const { highlightHast } = await import("fumadocs-core/highlight/shiki");
    const { toJsxRuntime } = await import("hast-util-to-jsx-runtime");
    const JsxRuntime = await import("react/jsx-runtime");
    const { CodeBlock, Pre } = await import("fumadocs-ui/components/codeblock");

    return jsx(CodeBlock, {
      className: "my-0",
      children: toJsxRuntime(
        await highlightHast(await defaultShikiFactory.getOrInit(), code, {
          lang,
          defaultColor: false,
          themes: { light: "github-light", dark: "github-dark" },
        }),
        {
          ...JsxRuntime,
          components: { pre: Pre },
        },
      ),
    });
  },
});
