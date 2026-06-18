import { source } from "@/lib/source";
import { openapi } from "@/lib/openapi";
import type { OpenAPIPageProps } from "fumadocs-openapi/ui";
import { DocsPage, DocsBody } from "fumadocs-ui/page";
import { notFound } from "next/navigation";
import defaultComponents from "fumadocs-ui/mdx";
import { APIPage } from "@/components/api-page";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { Callout } from "fumadocs-ui/components/callout";
import { Step, Steps } from "fumadocs-ui/components/steps";
import {
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "@/components/ai/page-actions";
import { DocsFeedback } from "@/components/docs-feedback";

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  // v11: the OpenAPI page component is preloaded per-request and given the bundled
  // schema via `preloaded` props, which the generated MDX's own props are spread on top of.
  const components = {
    ...defaultComponents,
    APIPage: async (apiPageProps: Record<string, unknown>) => {
      // The generated MDX supplies the spec props (document/operations/…) at
      // runtime; we add the per-request `preloaded` schema. Cast because the
      // MDX-provided props are only known structurally as a record here.
      const preloaded = await openapi.preloadOpenAPIPage(page);
      return (
        <APIPage {...({ ...preloaded, ...apiPageProps } as OpenAPIPageProps)} />
      );
    },
    Tab,
    Tabs,
    Callout,
    Steps,
    Step,
  };

  const MDXContent = page.data.body;
  const isApiPage = page.data.full;
  const markdownUrl = page.url === "/" ? "/index.mdx" : `${page.url}.mdx`;
  const sourcePath = `apps/docs/content/docs/${page.path}`;

  if (isApiPage) {
    return (
      <DocsPage full>
        <div className="api-page-header">
          <h1 className="api-page-title">{page.data.title}</h1>
          {page.data.description && (
            <p className="api-page-description">{page.data.description}</p>
          )}
          <div className="flex items-center gap-2 pt-2">
            <MarkdownCopyButton markdownUrl={markdownUrl}>
              Copy for AI
            </MarkdownCopyButton>
            <ViewOptionsPopover markdownUrl={markdownUrl} />
          </div>
        </div>
        <MDXContent components={components} />
        <DocsFeedback title={page.data.title} pageUrl={page.url} sourcePath={sourcePath} />
      </DocsPage>
    );
  }

  return (
    <DocsPage toc={page.data.toc} tableOfContent={{ style: 'clerk' }}>
      <DocsBody>
        <div className="flex items-start justify-between gap-4">
          <h1>{page.data.title}</h1>
          <div className="flex items-center gap-2 shrink-0">
            <MarkdownCopyButton markdownUrl={markdownUrl}>
              Copy for AI
            </MarkdownCopyButton>
            <ViewOptionsPopover markdownUrl={markdownUrl} />
          </div>
        </div>
        {page.data.description && (
          <p className="text-fd-muted-foreground text-lg mb-8">
            {page.data.description}
          </p>
        )}
        <MDXContent components={components} />
        <DocsFeedback title={page.data.title} pageUrl={page.url} sourcePath={sourcePath} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const title = page.data.title;
  const description = page.data.description;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
      url: `https://docs.relayapi.dev${page.url}`,
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}
