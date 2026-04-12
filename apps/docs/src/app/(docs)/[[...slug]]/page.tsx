import { source } from "@/lib/source";
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

const components = {
  ...defaultComponents,
  APIPage,
  Tab,
  Tabs,
  Callout,
  Steps,
  Step,
};

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDXContent = page.data.body;
  const isApiPage = page.data.full;
  const markdownUrl = page.url === "/" ? "/index.mdx" : `${page.url}.mdx`;
  const sourcePath = params.slug
    ? `apps/docs/content/docs/${params.slug.join("/")}.mdx`
    : "apps/docs/content/docs/index.mdx";

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
