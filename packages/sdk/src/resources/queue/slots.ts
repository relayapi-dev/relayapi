// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { buildHeaders } from '../../internal/headers';
import { RequestOptions } from '../../internal/request-options';

export class Slots extends APIResource {
  /**
   * Create a queue schedule
   */
  create(body: SlotCreateParams, options?: RequestOptions): APIPromise<SlotCreateResponse> {
    return this._client.post('/v1/queue/slots', { body, ...options });
  }

  /**
   * Update queue schedule
   */
  update(
    body: SlotUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<SlotUpdateResponse> {
    return this._client.put('/v1/queue/slots', { body, ...options });
  }

  /**
   * List queue schedules
   */
  list(options?: RequestOptions): APIPromise<SlotListResponse> {
    return this._client.get('/v1/queue/slots', options);
  }

  /**
   * Delete queue schedule
   */
  delete(options?: RequestOptions): APIPromise<void> {
    return this._client.delete('/v1/queue/slots', {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface SlotCreateResponse {
  /**
   * Queue schedule ID
   */
  id: string;

  /**
   * Created timestamp
   */
  created_at: string;

  /**
   * Whether this is the default schedule
   */
  is_default: boolean;

  /**
   * Time slots
   */
  slots: Array<SlotCreateResponse.Slot>;

  /**
   * Updated timestamp
   */
  updated_at: string;

  /**
   * Schedule name
   */
  name?: string | null;
}

export namespace SlotCreateResponse {
  export interface Slot {
    /**
     * Day of week (0=Sunday, 6=Saturday)
     */
    day_of_week: number;

    /**
     * Time in HH:MM format
     */
    time: string;

    /**
     * IANA timezone (e.g. America/New_York)
     */
    timezone: string;
  }
}

export interface SlotUpdateResponse {
  /**
   * Queue schedule ID
   */
  id: string;

  /**
   * Created timestamp
   */
  created_at: string;

  /**
   * Whether this is the default schedule
   */
  is_default: boolean;

  /**
   * Time slots
   */
  slots: Array<SlotUpdateResponse.Slot>;

  /**
   * Updated timestamp
   */
  updated_at: string;

  /**
   * Schedule name
   */
  name?: string | null;
}

export namespace SlotUpdateResponse {
  export interface Slot {
    /**
     * Day of week (0=Sunday, 6=Saturday)
     */
    day_of_week: number;

    /**
     * Time in HH:MM format
     */
    time: string;

    /**
     * IANA timezone (e.g. America/New_York)
     */
    timezone: string;
  }
}

export interface SlotListResponse {
  data: Array<SlotListResponse.Data>;
}

export namespace SlotListResponse {
  export interface Data {
    /**
     * Queue schedule ID
     */
    id: string;

    /**
     * Created timestamp
     */
    created_at: string;

    /**
     * Whether this is the default schedule
     */
    is_default: boolean;

    /**
     * Time slots
     */
    slots: Array<Data.Slot>;

    /**
     * Updated timestamp
     */
    updated_at: string;

    /**
     * Schedule name
     */
    name?: string | null;
  }

  export namespace Data {
    export interface Slot {
      /**
       * Day of week (0=Sunday, 6=Saturday)
       */
      day_of_week: number;

      /**
       * Time in HH:MM format
       */
      time: string;

      /**
       * IANA timezone (e.g. America/New_York)
       */
      timezone: string;
    }
  }
}

export interface SlotCreateParams {
  /**
   * Time slots
   */
  slots: Array<SlotCreateParams.Slot>;

  /**
   * Default timezone for slots
   */
  timezone: string;

  /**
   * Schedule name
   */
  name?: string;
}

export namespace SlotCreateParams {
  export interface Slot {
    /**
     * Day of week (0=Sunday, 6=Saturday)
     */
    day_of_week: number;

    /**
     * Time in HH:MM format
     */
    time: string;

    /**
     * IANA timezone (e.g. America/New_York)
     */
    timezone: string;
  }
}

export interface SlotUpdateParams {
  /**
   * Schedule name
   */
  name?: string;

  /**
   * Set this schedule as the default
   */
  set_as_default?: boolean;

  /**
   * Updated time slots
   */
  slots?: Array<SlotUpdateParams.Slot>;
}

export namespace SlotUpdateParams {
  export interface Slot {
    /**
     * Day of week (0=Sunday, 6=Saturday)
     */
    day_of_week: number;

    /**
     * Time in HH:MM format
     */
    time: string;

    /**
     * IANA timezone (e.g. America/New_York)
     */
    timezone: string;
  }
}

export declare namespace Slots {
  export {
    type SlotCreateResponse as SlotCreateResponse,
    type SlotUpdateResponse as SlotUpdateResponse,
    type SlotListResponse as SlotListResponse,
    type SlotCreateParams as SlotCreateParams,
    type SlotUpdateParams as SlotUpdateParams,
  };
}
