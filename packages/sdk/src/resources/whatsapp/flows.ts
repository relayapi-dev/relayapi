// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Flows extends APIResource {
  /**
   * List WhatsApp Flows
   */
  list(query: FlowListParams, options?: RequestOptions): APIPromise<FlowListResponse> {
    return this._client.get('/v1/whatsapp/flows', { query, ...options });
  }

  /**
   * Create a WhatsApp Flow (DRAFT)
   */
  create(body: FlowCreateParams, options?: RequestOptions): APIPromise<FlowCreateResponse> {
    return this._client.post('/v1/whatsapp/flows', { body, ...options });
  }

  /**
   * Get flow details
   */
  retrieve(flowId: string, query: FlowRetrieveParams, options?: RequestOptions): APIPromise<FlowRetrieveResponse> {
    return this._client.get(path`/v1/whatsapp/flows/${flowId}`, { query, ...options });
  }

  /**
   * Update flow metadata (DRAFT only)
   */
  update(flowId: string, body: FlowUpdateParams, options?: RequestOptions): APIPromise<FlowUpdateResponse> {
    return this._client.patch(path`/v1/whatsapp/flows/${flowId}`, { body, ...options });
  }

  /**
   * Delete a DRAFT flow
   */
  delete(flowId: string, query: FlowDeleteParams, options?: RequestOptions): APIPromise<FlowDeleteResponse> {
    return this._client.delete(path`/v1/whatsapp/flows/${flowId}`, { query, ...options });
  }

  /**
   * Publish a flow (irreversible)
   */
  publish(flowId: string, body: FlowPublishParams, options?: RequestOptions): APIPromise<FlowPublishResponse> {
    return this._client.post(path`/v1/whatsapp/flows/${flowId}/publish`, { body, ...options });
  }

  /**
   * Deprecate a published flow (irreversible)
   */
  deprecate(flowId: string, body: FlowDeprecateParams, options?: RequestOptions): APIPromise<FlowDeprecateResponse> {
    return this._client.post(path`/v1/whatsapp/flows/${flowId}/deprecate`, { body, ...options });
  }

  /**
   * Get flow JSON asset
   */
  getJson(flowId: string, query: FlowGetJsonParams, options?: RequestOptions): APIPromise<FlowGetJsonResponse> {
    return this._client.get(path`/v1/whatsapp/flows/${flowId}/json`, { query, ...options });
  }

  /**
   * Upload flow JSON definition (DRAFT only)
   */
  uploadJson(flowId: string, body: FlowUploadJsonParams, options?: RequestOptions): APIPromise<FlowUploadJsonResponse> {
    return this._client.put(path`/v1/whatsapp/flows/${flowId}/json`, { body, ...options });
  }

  /**
   * Send a published flow as an interactive message
   */
  send(body: FlowSendParams, options?: RequestOptions): APIPromise<FlowSendResponse> {
    return this._client.post('/v1/whatsapp/flows/send', { body, ...options });
  }
}

export interface FlowResource {
  id: string;
  name: string;
  status: 'DRAFT' | 'PUBLISHED' | 'DEPRECATED' | 'BLOCKED' | 'THROTTLED';
  categories: Array<string>;
  validation_errors?: Array<{
    error: string;
    error_type: string;
    message: string;
    line_start?: number;
    line_end?: number;
    column_start?: number;
    column_end?: number;
  }>;
  preview?: {
    preview_url: string;
    expires_at: string;
  } | null;
  json_version?: string;
  data_api_version?: string;
}

export interface FlowListResponse {
  data: Array<FlowResource>;
}

export type FlowCreateResponse = FlowResource;
export type FlowRetrieveResponse = FlowResource;
export type FlowUpdateResponse = FlowResource;

export interface FlowDeleteResponse {
  success: boolean;
}

export interface FlowPublishResponse {
  success: boolean;
}

export interface FlowDeprecateResponse {
  success: boolean;
}

export interface FlowGetJsonResponse {
  download_url: string | null;
  expires_at: string | null;
}

export interface FlowUploadJsonResponse {
  success: boolean;
  validation_errors?: Array<unknown>;
}

export interface FlowSendResponse {
  message_id: string;
}

export interface FlowListParams {
  account_id: string;
}

export interface FlowCreateParams {
  account_id: string;
  name: string;
  categories: Array<
    'SIGN_UP' | 'SIGN_IN' | 'APPOINTMENT_BOOKING' | 'LEAD_GENERATION' |
    'CONTACT_US' | 'CUSTOMER_SUPPORT' | 'SURVEY' | 'OTHER'
  >;
  clone_flow_id?: string;
}

export interface FlowRetrieveParams {
  account_id: string;
}

export interface FlowUpdateParams {
  account_id: string;
  name?: string;
  categories?: Array<
    'SIGN_UP' | 'SIGN_IN' | 'APPOINTMENT_BOOKING' | 'LEAD_GENERATION' |
    'CONTACT_US' | 'CUSTOMER_SUPPORT' | 'SURVEY' | 'OTHER'
  >;
}

export interface FlowDeleteParams {
  account_id: string;
}

export interface FlowPublishParams {
  account_id: string;
}

export interface FlowDeprecateParams {
  account_id: string;
}

export interface FlowGetJsonParams {
  account_id: string;
}

export interface FlowUploadJsonParams {
  account_id: string;
  flow_json: Record<string, unknown>;
}

export interface FlowSendParams {
  account_id: string;
  recipient_phone: string;
  flow_id: string;
  flow_token: string;
  body_text: string;
  cta_text: string;
  screen_id: string;
  header_text?: string;
  footer_text?: string;
  flow_data?: Record<string, unknown>;
}

export declare namespace Flows {
  export {
    type FlowResource as FlowResource,
    type FlowListResponse as FlowListResponse,
    type FlowCreateResponse as FlowCreateResponse,
    type FlowRetrieveResponse as FlowRetrieveResponse,
    type FlowUpdateResponse as FlowUpdateResponse,
    type FlowDeleteResponse as FlowDeleteResponse,
    type FlowPublishResponse as FlowPublishResponse,
    type FlowDeprecateResponse as FlowDeprecateResponse,
    type FlowGetJsonResponse as FlowGetJsonResponse,
    type FlowUploadJsonResponse as FlowUploadJsonResponse,
    type FlowSendResponse as FlowSendResponse,
    type FlowListParams as FlowListParams,
    type FlowCreateParams as FlowCreateParams,
    type FlowRetrieveParams as FlowRetrieveParams,
    type FlowUpdateParams as FlowUpdateParams,
    type FlowDeleteParams as FlowDeleteParams,
    type FlowPublishParams as FlowPublishParams,
    type FlowDeprecateParams as FlowDeprecateParams,
    type FlowGetJsonParams as FlowGetJsonParams,
    type FlowUploadJsonParams as FlowUploadJsonParams,
    type FlowSendParams as FlowSendParams,
  };
}
