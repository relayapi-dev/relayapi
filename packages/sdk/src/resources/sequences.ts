// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class Sequences extends APIResource {
  /**
   * Create a new sequence
   */
  create(body: SequenceCreateParams, options?: RequestOptions): APIPromise<SequenceDetailResponse> {
    return this._client.post('/v1/sequences', { body, ...options });
  }

  /**
   * Retrieve a sequence by ID
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<SequenceDetailResponse> {
    return this._client.get(path`/v1/sequences/${id}`, options);
  }

  /**
   * Update a sequence
   */
  update(
    id: string,
    body: SequenceUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<SequenceDetailResponse> {
    return this._client.patch(path`/v1/sequences/${id}`, { body, ...options });
  }

  /**
   * List sequences
   */
  list(
    query: SequenceListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<SequenceListResponse> {
    return this._client.get('/v1/sequences', { query, ...options });
  }

  /**
   * Delete a sequence
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/sequences/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Activate a sequence
   */
  activate(id: string, options?: RequestOptions): APIPromise<SequenceResponse> {
    return this._client.post(path`/v1/sequences/${id}/activate`, options);
  }

  /**
   * Pause a sequence
   */
  pause(id: string, options?: RequestOptions): APIPromise<SequenceResponse> {
    return this._client.post(path`/v1/sequences/${id}/pause`, options);
  }

  /**
   * Enroll contacts in a sequence
   */
  enroll(
    id: string,
    body: SequenceEnrollParams,
    options?: RequestOptions,
  ): APIPromise<SequenceEnrollResponse> {
    return this._client.post(path`/v1/sequences/${id}/enroll`, { body, ...options });
  }

  /**
   * Unenroll a contact from a sequence
   */
  unenroll(id: string, enrollmentId: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/sequences/${id}/enrollments/${enrollmentId}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * List enrollments for a sequence
   */
  listEnrollments(
    id: string,
    query: SequenceListEnrollmentsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<SequenceEnrollmentListResponse> {
    return this._client.get(path`/v1/sequences/${id}/enrollments`, { query, ...options });
  }
}

export interface SequenceResponse {
  id: string;

  name: string;

  description: string | null;

  platform: string;

  account_id: string;

  status: string;

  exit_on_reply: boolean;

  exit_on_unsubscribe: boolean;

  steps_count: number;

  total_enrolled: number;

  total_completed: number;

  total_exited: number;

  created_at: string;
}

export interface SequenceStepResponse {
  id: string;

  order: number;

  delay_minutes: number;

  message_type: string;

  message_text: string | null;

  template_name: string | null;

  template_language: string | null;

  template_components: Array<Record<string, unknown>> | null;

  created_at: string;
}

export interface SequenceDetailResponse extends SequenceResponse {
  steps: SequenceStepResponse[];
}

export interface SequenceListResponse {
  data: SequenceResponse[];

  next_cursor: string | null;

  has_more: boolean;
}

export interface SequenceEnrollResponse {
  enrolled: number;

  skipped: number;
}

export interface SequenceEnrollmentResponse {
  id: string;

  contact_id: string;

  contact_identifier: string;

  status: string;

  current_step_index: number;

  steps_sent: number;

  next_step_at: string | null;

  last_step_sent_at: string | null;

  exit_reason: string | null;

  enrolled_at: string;
}

export interface SequenceEnrollmentListResponse {
  data: SequenceEnrollmentResponse[];

  next_cursor: string | null;

  has_more: boolean;
}

export interface SequenceCreateParams {
  name: string;

  platform: string;

  account_id: string;

  workspace_id?: string;

  description?: string;

  exit_on_reply?: boolean;

  exit_on_unsubscribe?: boolean;

  steps?: Array<{
    order: number;
    delay_minutes: number;
    message_type?: 'text' | 'template';
    message_text?: string;
    template_name?: string;
    template_language?: string;
    template_components?: Array<Record<string, unknown>>;
  }>;
}

export interface SequenceUpdateParams {
  name?: string;

  description?: string | null;

  exit_on_reply?: boolean;

  exit_on_unsubscribe?: boolean;

  steps?: Array<{
    order: number;
    delay_minutes: number;
    message_type?: 'text' | 'template';
    message_text?: string;
    template_name?: string;
    template_language?: string;
    template_components?: Array<Record<string, unknown>>;
  }>;
}

export interface SequenceListParams {
  workspace_id?: string;

  cursor?: string;

  limit?: number;
}

export interface SequenceEnrollParams {
  contact_ids: string[];
}

export interface SequenceListEnrollmentsParams {
  cursor?: string;

  limit?: number;
}

export declare namespace Sequences {
  export {
    type SequenceResponse as SequenceResponse,
    type SequenceStepResponse as SequenceStepResponse,
    type SequenceDetailResponse as SequenceDetailResponse,
    type SequenceListResponse as SequenceListResponse,
    type SequenceEnrollResponse as SequenceEnrollResponse,
    type SequenceEnrollmentResponse as SequenceEnrollmentResponse,
    type SequenceEnrollmentListResponse as SequenceEnrollmentListResponse,
    type SequenceListParams as SequenceListParams,
    type SequenceCreateParams as SequenceCreateParams,
    type SequenceUpdateParams as SequenceUpdateParams,
    type SequenceEnrollParams as SequenceEnrollParams,
    type SequenceListEnrollmentsParams as SequenceListEnrollmentsParams,
  };
}
