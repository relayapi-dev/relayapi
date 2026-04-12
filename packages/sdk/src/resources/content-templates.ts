import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class ContentTemplates extends APIResource {
  /**
   * Create a content template
   */
  create(
    body: ContentTemplateCreateParams,
    options?: RequestOptions,
  ): APIPromise<ContentTemplateCreateResponse> {
    return this._client.post('/v1/content-templates', { body, ...options });
  }

  /**
   * Update a content template
   */
  update(
    id: string,
    body: ContentTemplateUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<ContentTemplateUpdateResponse> {
    return this._client.patch(path`/v1/content-templates/${id}`, { body, ...options });
  }

  /**
   * List content templates
   */
  list(
    query: ContentTemplateListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<ContentTemplateListResponse> {
    return this._client.get('/v1/content-templates', { query, ...options });
  }

  /**
   * Get a content template
   */
  get(id: string, options?: RequestOptions): APIPromise<ContentTemplateGetResponse> {
    return this._client.get(path`/v1/content-templates/${id}`, options);
  }

  /**
   * Delete a content template
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/content-templates/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface ContentTemplateCreateResponse {
  id: string;
  name: string;
  description: string | null;
  content: string;
  platform_overrides: Record<string, string> | null;
  tags: Array<string>;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContentTemplateUpdateResponse {
  id: string;
  name: string;
  description: string | null;
  content: string;
  platform_overrides: Record<string, string> | null;
  tags: Array<string>;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContentTemplateGetResponse {
  id: string;
  name: string;
  description: string | null;
  content: string;
  platform_overrides: Record<string, string> | null;
  tags: Array<string>;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContentTemplateListResponse {
  data: Array<ContentTemplateListResponse.Data>;
  has_more: boolean;
  next_cursor: string | null;
}

export namespace ContentTemplateListResponse {
  export interface Data {
    id: string;
    name: string;
    description: string | null;
    content: string;
    platform_overrides: Record<string, string> | null;
    tags: Array<string>;
    workspace_id: string | null;
    created_at: string;
    updated_at: string;
  }
}

export interface ContentTemplateCreateParams {
  name: string;
  content: string;
  description?: string;
  platform_overrides?: Record<string, string>;
  tags?: Array<string>;
  workspace_id?: string;
}

export interface ContentTemplateUpdateParams {
  name?: string;
  description?: string | null;
  content?: string;
  platform_overrides?: Record<string, string> | null;
  tags?: Array<string>;
}

export interface ContentTemplateListParams {
  cursor?: string;
  limit?: number;
  workspace_id?: string;
  tag?: string;
}

export declare namespace ContentTemplates {
  export {
    type ContentTemplateCreateResponse as ContentTemplateCreateResponse,
    type ContentTemplateUpdateResponse as ContentTemplateUpdateResponse,
    type ContentTemplateGetResponse as ContentTemplateGetResponse,
    type ContentTemplateListResponse as ContentTemplateListResponse,
    type ContentTemplateCreateParams as ContentTemplateCreateParams,
    type ContentTemplateUpdateParams as ContentTemplateUpdateParams,
    type ContentTemplateListParams as ContentTemplateListParams,
  };
}
