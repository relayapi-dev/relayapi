import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class Signatures extends APIResource {
  /**
   * Create a signature
   */
  create(body: SignatureCreateParams, options?: RequestOptions): APIPromise<SignatureCreateResponse> {
    return this._client.post('/v1/signatures', { body, ...options });
  }

  /**
   * Update a signature
   */
  update(
    id: string,
    body: SignatureUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<SignatureUpdateResponse> {
    return this._client.patch(path`/v1/signatures/${id}`, { body, ...options });
  }

  /**
   * List signatures
   */
  list(
    query: SignatureListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<SignatureListResponse> {
    return this._client.get('/v1/signatures', { query, ...options });
  }

  /**
   * Get a signature
   */
  get(id: string, options?: RequestOptions): APIPromise<SignatureGetResponse> {
    return this._client.get(path`/v1/signatures/${id}`, options);
  }

  /**
   * Delete a signature
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/signatures/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Get the default signature
   */
  getDefault(options?: RequestOptions): APIPromise<SignatureGetDefaultResponse> {
    return this._client.get('/v1/signatures/default', options);
  }

  /**
   * Set a signature as the default. Clears isDefault on all other signatures.
   */
  setDefault(id: string, options?: RequestOptions): APIPromise<SignatureSetDefaultResponse> {
    return this._client.post(path`/v1/signatures/${id}/set-default`, options);
  }
}

export interface SignatureCreateResponse {
  id: string;
  name: string;
  content: string;
  is_default: boolean;
  position: 'append' | 'prepend';
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SignatureUpdateResponse {
  id: string;
  name: string;
  content: string;
  is_default: boolean;
  position: 'append' | 'prepend';
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SignatureGetResponse {
  id: string;
  name: string;
  content: string;
  is_default: boolean;
  position: 'append' | 'prepend';
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SignatureGetDefaultResponse {
  id: string;
  name: string;
  content: string;
  is_default: boolean;
  position: 'append' | 'prepend';
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SignatureSetDefaultResponse {
  id: string;
  name: string;
  content: string;
  is_default: boolean;
  position: 'append' | 'prepend';
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SignatureListResponse {
  data: Array<SignatureListResponse.Data>;
  has_more: boolean;
  next_cursor: string | null;
}

export namespace SignatureListResponse {
  export interface Data {
    id: string;
    name: string;
    content: string;
    is_default: boolean;
    position: 'append' | 'prepend';
    workspace_id: string | null;
    created_at: string;
    updated_at: string;
  }
}

export interface SignatureCreateParams {
  name: string;
  content: string;
  is_default?: boolean;
  position?: 'append' | 'prepend';
  workspace_id?: string;
}

export interface SignatureUpdateParams {
  name?: string;
  content?: string;
  is_default?: boolean;
  position?: 'append' | 'prepend';
}

export interface SignatureListParams {
  cursor?: string;
  limit?: number;
  workspace_id?: string;
}

export declare namespace Signatures {
  export {
    type SignatureCreateResponse as SignatureCreateResponse,
    type SignatureUpdateResponse as SignatureUpdateResponse,
    type SignatureGetResponse as SignatureGetResponse,
    type SignatureGetDefaultResponse as SignatureGetDefaultResponse,
    type SignatureSetDefaultResponse as SignatureSetDefaultResponse,
    type SignatureListResponse as SignatureListResponse,
    type SignatureCreateParams as SignatureCreateParams,
    type SignatureUpdateParams as SignatureUpdateParams,
    type SignatureListParams as SignatureListParams,
  };
}
