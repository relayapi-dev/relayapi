// Hand-written scaffold matching /v1/segments routes. Superseded by Stainless
// regeneration on the next OpenAPI pass.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class Segments extends APIResource {
  create(body: SegmentCreateParams, options?: RequestOptions): APIPromise<SegmentResponse> {
    return this._client.post('/v1/segments', { body, ...options });
  }

  list(
    query: SegmentListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<SegmentListResponse> {
    return this._client.get('/v1/segments', { query, ...options });
  }

  retrieve(id: string, options?: RequestOptions): APIPromise<SegmentResponse> {
    return this._client.get(path`/v1/segments/${id}`, options);
  }

  update(
    id: string,
    body: SegmentUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<SegmentResponse> {
    return this._client.patch(path`/v1/segments/${id}`, { body, ...options });
  }

  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/segments/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export type SegmentFilterPredicate =
  | {
      field: 'tags' | 'contact.tags';
      op: 'contains' | 'not_contains';
      value: string;
    }
  | {
      field: 'opted_in' | 'contact.opted_in';
      op: 'eq' | 'neq';
      value: boolean;
    }
  | {
      field: 'created_at' | 'contact.created_at' | 'updated_at' | 'contact.updated_at';
      op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
      value: string;
    }
  | {
      field: `fields.${string}`;
      op: 'exists' | 'not_exists';
    }
  | {
      field: `fields.${string}`;
      op: 'gt' | 'gte' | 'lt' | 'lte';
      value: number;
    }
  | {
      field: `fields.${string}`;
      op: 'eq' | 'neq';
      value: string | number | boolean;
      case_sensitive?: boolean;
    }
  | {
      field: `fields.${string}`;
      op: 'contains' | 'not_contains' | 'starts_with' | 'ends_with';
      value: string;
      case_sensitive?: boolean;
    }
  | {
      field: `fields.${string}`;
      op: 'in' | 'not_in';
      value: Array<string | number | boolean>;
      case_sensitive?: boolean;
    };

export interface SegmentFilter {
  all?: SegmentFilterPredicate[];
  any?: SegmentFilterPredicate[];
  none?: SegmentFilterPredicate[];
}

export interface SegmentCreateParams {
  name: string;
  description?: string;
  workspace_id?: string;
  /**
   * Required for dynamic segments and omitted/null for static segments.
   */
  filter?: SegmentFilter | null;
  is_dynamic?: boolean;
}

export interface SegmentUpdateParams extends Partial<SegmentCreateParams> {}

export interface SegmentListParams {
  cursor?: string;
  limit?: number;
  workspace_id?: string;
}

export interface SegmentResponse {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  name: string;
  description: string | null;
  filter: SegmentFilter | null;
  is_dynamic: boolean;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface SegmentListResponse {
  data: SegmentResponse[];
  next_cursor: string | null;
  has_more: boolean;
}
