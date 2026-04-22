// Hand-written scaffold matching /v1/ref-urls routes. Superseded by Stainless
// regeneration on the next OpenAPI pass.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class RefUrls extends APIResource {
  create(body: RefUrlCreateParams, options?: RequestOptions): APIPromise<RefUrlResponse> {
    return this._client.post('/v1/ref-urls', { body, ...options });
  }

  list(
    query: RefUrlListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<RefUrlListResponse> {
    return this._client.get('/v1/ref-urls', { query, ...options });
  }

  retrieve(id: string, options?: RequestOptions): APIPromise<RefUrlResponse> {
    return this._client.get(path`/v1/ref-urls/${id}`, options);
  }

  update(
    id: string,
    body: RefUrlUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<RefUrlResponse> {
    return this._client.patch(path`/v1/ref-urls/${id}`, { body, ...options });
  }

  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/ref-urls/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Records a click on a ref URL and, when a contact is supplied, fires a
   * `ref_link_click` automation event so matching entrypoints enroll the
   * contact.
   */
  recordClick(
    id: string,
    body: RefUrlClickParams,
    options?: RequestOptions,
  ): APIPromise<RefUrlResponse> {
    return this._client.post(path`/v1/ref-urls/${id}/click`, { body, ...options });
  }
}

export interface RefUrlCreateParams {
  slug: string;
  workspace_id?: string;
  automation_id?: string | null;
  enabled?: boolean;
}

export interface RefUrlUpdateParams {
  slug?: string;
  automation_id?: string | null;
  enabled?: boolean;
}

export interface RefUrlListParams {
  cursor?: string;
  limit?: number;
  workspace_id?: string;
  automation_id?: string;
}

export interface RefUrlResponse {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  slug: string;
  automation_id: string | null;
  uses: number;
  enabled: boolean;
  created_at: string;
}

export interface RefUrlListResponse {
  data: RefUrlResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface RefUrlClickParams {
  contact_id: string;
}
