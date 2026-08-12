// Hand-written scaffold matching /v1/ai-knowledge routes. Superseded by
// Stainless regeneration on the next OpenAPI pass.

import { APIPromise } from '../core/api-promise';
import { APIResource } from '../core/resource';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class AiKnowledge extends APIResource {
  documents: AiKnowledgeDocuments = new AiKnowledgeDocuments(this._client);

  create(
    body: KnowledgeBaseCreateParams,
    options?: RequestOptions,
  ): APIPromise<KnowledgeBaseResponse> {
    return this._client.post('/v1/ai-knowledge', { body, ...options });
  }

  list(
    query: KnowledgeBaseListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<KnowledgeBaseListResponse> {
    return this._client.get('/v1/ai-knowledge', { query, ...options });
  }

  retrieve(id: string, options?: RequestOptions): APIPromise<KnowledgeBaseResponse> {
    return this._client.get(path`/v1/ai-knowledge/${id}`, options);
  }

  update(
    id: string,
    body: KnowledgeBaseUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<KnowledgeBaseResponse> {
    return this._client.patch(path`/v1/ai-knowledge/${id}`, { body, ...options });
  }

  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/ai-knowledge/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  search(
    id: string,
    body: KnowledgeSearchParams,
    options?: RequestOptions,
  ): APIPromise<KnowledgeSearchResponse> {
    return this._client.post(path`/v1/ai-knowledge/${id}/search`, {
      body,
      ...options,
    });
  }
}

export class AiKnowledgeDocuments extends APIResource {
  create(
    kbId: string,
    body: KnowledgeDocumentCreateParams,
    options?: RequestOptions,
  ): APIPromise<KnowledgeDocumentResponse> {
    return this._client.post(path`/v1/ai-knowledge/${kbId}/documents`, {
      body,
      ...options,
    });
  }

  list(
    kbId: string,
    query: KnowledgeDocumentListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<KnowledgeDocumentListResponse> {
    return this._client.get(path`/v1/ai-knowledge/${kbId}/documents`, {
      query,
      ...options,
    });
  }

  retry(
    kbId: string,
    documentId: string,
    options?: RequestOptions,
  ): APIPromise<KnowledgeDocumentResponse> {
    return this._client.post(
      path`/v1/ai-knowledge/${kbId}/documents/${documentId}/retry`,
      options,
    );
  }

  delete(kbId: string, documentId: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/ai-knowledge/${kbId}/documents/${documentId}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface KnowledgeBaseCreateParams {
  name: string;
  description?: string;
  workspace_id?: string;
}

export interface KnowledgeBaseUpdateParams {
  name?: string;
  description?: string | null;
}

export interface KnowledgeBaseListParams {
  cursor?: string;
  limit?: number;
  workspace_id?: string;
}

export interface KnowledgeBaseResponse {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  name: string;
  description: string | null;
  embedding_provider: 'openai';
  embedding_model: 'text-embedding-3-small';
  embedding_dimensions: 1536;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeBaseListResponse {
  data: KnowledgeBaseResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

interface KnowledgeDocumentCreateCommon {
  title?: string;
}

export type KnowledgeDocumentCreateParams =
  | (KnowledgeDocumentCreateCommon & {
      source_type: 'url';
      url: string;
    })
  | (KnowledgeDocumentCreateCommon & {
      source_type: 'media';
      media_id: string;
    })
  | (KnowledgeDocumentCreateCommon & {
      source_type: 'text';
      text: string;
    });

export interface KnowledgeDocumentListParams {
  cursor?: string;
  limit?: number;
}

export type KnowledgeDocumentStatus =
  | 'pending'
  | 'in_flight'
  | 'ready'
  | 'retryable_failure'
  | 'terminal_failure';

export interface KnowledgeDocumentResponse {
  id: string;
  kb_id: string;
  source_type: 'url' | 'media' | 'text';
  source_url: string | null;
  source_media_id: string | null;
  title: string | null;
  status: KnowledgeDocumentStatus;
  attempt_count: number;
  next_attempt_at: string;
  last_crawled_at: string | null;
  last_error_code: string | null;
  last_error: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeDocumentListResponse {
  data: KnowledgeDocumentResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface KnowledgeSearchParams {
  query: string;
  limit?: number;
}

export interface KnowledgeSearchResult {
  chunk_id: string;
  document_id: string;
  content: string;
  similarity: number;
}

export interface KnowledgeSearchResponse {
  data: KnowledgeSearchResult[];
}
