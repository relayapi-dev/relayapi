// Hand-written scaffold matching /v1/ai-knowledge routes. Superseded by
// Stainless regeneration on the next OpenAPI pass.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
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
}

export class AiKnowledgeDocuments extends APIResource {
  create(
    kbId: string,
    body: KnowledgeDocumentCreateParams,
    options?: RequestOptions,
  ): APIPromise<KnowledgeDocumentResponse> {
    return this._client.post(path`/v1/ai-knowledge/${kbId}/documents`, { body, ...options });
  }

  list(
    kbId: string,
    query: KnowledgeDocumentListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<KnowledgeDocumentListResponse> {
    return this._client.get(path`/v1/ai-knowledge/${kbId}/documents`, { query, ...options });
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
  embedding_model?: string;
  embedding_dimensions?: number;
}

export interface KnowledgeBaseUpdateParams extends Partial<KnowledgeBaseCreateParams> {}

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
  embedding_model: string;
  embedding_dimensions: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeBaseListResponse {
  data: KnowledgeBaseResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface KnowledgeDocumentCreateParams {
  source_type: 'url' | 'file' | 'text';
  source_ref: string;
  title?: string;
}

export interface KnowledgeDocumentListParams {
  cursor?: string;
  limit?: number;
}

export interface KnowledgeDocumentResponse {
  id: string;
  kb_id: string;
  source_type: string;
  source_ref: string;
  title: string | null;
  status: string;
  last_crawled_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeDocumentListResponse {
  data: KnowledgeDocumentResponse[];
  next_cursor: string | null;
  has_more: boolean;
}
