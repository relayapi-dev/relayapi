// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { buildHeaders } from '../../internal/headers';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Broadcasts extends APIResource {
  /**
   * Create a broadcast
   */
  create(body: BroadcastCreateParams, options?: RequestOptions): APIPromise<BroadcastCreateResponse> {
    return this._client.post('/v1/whatsapp/broadcasts', { body, ...options });
  }

  /**
   * Get broadcast details
   */
  retrieve(broadcastID: string, options?: RequestOptions): APIPromise<BroadcastRetrieveResponse> {
    return this._client.get(path`/v1/whatsapp/broadcasts/${broadcastID}`, options);
  }

  /**
   * List broadcasts
   */
  list(query: BroadcastListParams, options?: RequestOptions): APIPromise<BroadcastListResponse> {
    return this._client.get('/v1/whatsapp/broadcasts', { query, ...options });
  }

  /**
   * Delete a broadcast
   */
  delete(broadcastID: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/whatsapp/broadcasts/${broadcastID}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Schedule a broadcast
   */
  schedule(broadcastID: string, options?: RequestOptions): APIPromise<BroadcastScheduleResponse> {
    return this._client.post(path`/v1/whatsapp/broadcasts/${broadcastID}/schedule`, options);
  }

  /**
   * Send a broadcast immediately
   */
  send(broadcastID: string, options?: RequestOptions): APIPromise<BroadcastSendResponse> {
    return this._client.post(path`/v1/whatsapp/broadcasts/${broadcastID}/send`, options);
  }
}

export interface BroadcastCreateResponse {
  /**
   * Broadcast ID
   */
  id: string;

  /**
   * Created timestamp
   */
  created_at: string;

  /**
   * Broadcast name
   */
  name: string;

  /**
   * Total recipients
   */
  recipient_count: number;

  /**
   * Broadcast status
   */
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed';

  /**
   * Template name
   */
  template: string;

  /**
   * Failed sends
   */
  failed?: number;

  /**
   * Scheduled time
   */
  scheduled_at?: string | null;

  /**
   * Successfully sent
   */
  sent?: number;
}

export interface BroadcastRetrieveResponse {
  /**
   * Broadcast ID
   */
  id: string;

  /**
   * Created timestamp
   */
  created_at: string;

  /**
   * Broadcast name
   */
  name: string;

  /**
   * Total recipients
   */
  recipient_count: number;

  /**
   * Broadcast status
   */
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed';

  /**
   * Template name
   */
  template: string;

  /**
   * Failed sends
   */
  failed?: number;

  /**
   * Scheduled time
   */
  scheduled_at?: string | null;

  /**
   * Successfully sent
   */
  sent?: number;
}

export interface BroadcastListResponse {
  data: Array<BroadcastListResponse.Data>;
}

export namespace BroadcastListResponse {
  export interface Data {
    /**
     * Broadcast ID
     */
    id: string;

    /**
     * Created timestamp
     */
    created_at: string;

    /**
     * Broadcast name
     */
    name: string;

    /**
     * Total recipients
     */
    recipient_count: number;

    /**
     * Broadcast status
     */
    status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed';

    /**
     * Template name
     */
    template: string;

    /**
     * Failed sends
     */
    failed?: number;

    /**
     * Scheduled time
     */
    scheduled_at?: string | null;

    /**
     * Successfully sent
     */
    sent?: number;
  }
}

export interface BroadcastScheduleResponse {
  /**
   * Broadcast ID
   */
  id: string;

  /**
   * Created timestamp
   */
  created_at: string;

  /**
   * Broadcast name
   */
  name: string;

  /**
   * Total recipients
   */
  recipient_count: number;

  /**
   * Broadcast status
   */
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed';

  /**
   * Template name
   */
  template: string;

  /**
   * Failed sends
   */
  failed?: number;

  /**
   * Scheduled time
   */
  scheduled_at?: string | null;

  /**
   * Successfully sent
   */
  sent?: number;
}

export interface BroadcastSendResponse {
  /**
   * Broadcast ID
   */
  id: string;

  /**
   * Created timestamp
   */
  created_at: string;

  /**
   * Broadcast name
   */
  name: string;

  /**
   * Total recipients
   */
  recipient_count: number;

  /**
   * Broadcast status
   */
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed';

  /**
   * Template name
   */
  template: string;

  /**
   * Failed sends
   */
  failed?: number;

  /**
   * Scheduled time
   */
  scheduled_at?: string | null;

  /**
   * Successfully sent
   */
  sent?: number;
}

export interface BroadcastCreateParams {
  /**
   * WhatsApp account ID
   */
  account_id: string;

  /**
   * Broadcast name
   */
  name: string;

  /**
   * Recipient list
   */
  recipients: Array<BroadcastCreateParams.Recipient>;

  template: BroadcastCreateParams.Template;

  /**
   * ISO 8601 timestamp to schedule send
   */
  scheduled_at?: string;
}

export namespace BroadcastCreateParams {
  export interface Recipient {
    /**
     * Phone number in E.164 format
     */
    phone: string;

    /**
     * Template variable substitutions
     */
    variables?: { [key: string]: string };
  }

  export interface Template {
    /**
     * Template language code
     */
    language: string;

    /**
     * Template name
     */
    name: string;

    components?: Array<Template.Component>;
  }

  export namespace Template {
    export interface Component {
      /**
       * Component type
       */
      type: 'header' | 'body' | 'button';

      /**
       * Component parameters
       */
      parameters?: Array<{ [key: string]: unknown }>;
    }
  }
}

export interface BroadcastListParams {
  /**
   * WhatsApp account ID
   */
  account_id: string;
}

export declare namespace Broadcasts {
  export {
    type BroadcastCreateResponse as BroadcastCreateResponse,
    type BroadcastRetrieveResponse as BroadcastRetrieveResponse,
    type BroadcastListResponse as BroadcastListResponse,
    type BroadcastScheduleResponse as BroadcastScheduleResponse,
    type BroadcastSendResponse as BroadcastSendResponse,
    type BroadcastCreateParams as BroadcastCreateParams,
    type BroadcastListParams as BroadcastListParams,
  };
}
