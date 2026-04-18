// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class CustomFields extends APIResource {
  /**
   * Create a custom field definition.
   */
  create(body: CustomFieldCreateParams, options?: RequestOptions): APIPromise<CustomFieldResponse> {
    return this._client.post('/v1/custom-fields', { body, ...options });
  }

  /**
   * List custom field definitions.
   */
  list(
    query: CustomFieldListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<CustomFieldListResponse> {
    return this._client.get('/v1/custom-fields', { query, ...options });
  }

  /**
   * Update a custom field definition.
   */
  update(
    id: string,
    body: CustomFieldUpdateParams,
    options?: RequestOptions,
  ): APIPromise<CustomFieldResponse> {
    return this._client.patch(path`/v1/custom-fields/${id}`, { body, ...options });
  }

  /**
   * Delete a custom field definition.
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/custom-fields/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface CustomFieldResponse {
  /**
   * Field definition ID
   */
  id: string;

  /**
   * Field name
   */
  name: string;

  /**
   * URL-safe identifier
   */
  slug: string;

  /**
   * Field type
   */
  type: 'text' | 'number' | 'date' | 'boolean' | 'select';

  /**
   * Select options
   */
  options?: Array<string> | null;

  /**
   * Created timestamp
   */
  created_at: string;
}

export interface CustomFieldListResponse {
  data: Array<CustomFieldResponse>;

  /**
   * Whether more items exist
   */
  has_more: boolean;

  /**
   * Cursor for next page
   */
  next_cursor: string | null;
}

export interface CustomFieldCreateParams {
  /**
   * Field name
   */
  name: string;

  /**
   * Field type
   */
  type: 'text' | 'number' | 'date' | 'boolean' | 'select';

  /**
   * URL-safe identifier (auto-generated from name if omitted)
   */
  slug?: string;

  /**
   * Options for select type (required when type is select)
   */
  options?: Array<string>;

  /**
   * Workspace ID to scope this field to
   */
  workspace_id?: string;
}

export interface CustomFieldUpdateParams {
  /**
   * Field name
   */
  name?: string;

  /**
   * Options for select type
   */
  options?: Array<string>;
}

export interface CustomFieldListParams {
  /**
   * Pagination cursor
   */
  cursor?: string;

  /**
   * Number of items per page
   */
  limit?: number;

  /**
   * Filter by workspace ID
   */
  workspace_id?: string;
}

export declare namespace CustomFields {
  export {
    type CustomFieldResponse as CustomFieldResponse,
    type CustomFieldListResponse as CustomFieldListResponse,
    type CustomFieldCreateParams as CustomFieldCreateParams,
    type CustomFieldUpdateParams as CustomFieldUpdateParams,
    type CustomFieldListParams as CustomFieldListParams,
  };
}
