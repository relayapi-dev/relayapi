// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as SlotsAPI from './slots';
import {
  SlotCreateParams,
  SlotCreateResponse,
  SlotListResponse,
  SlotUpdateParams,
  SlotUpdateResponse,
  Slots,
} from './slots';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';

export class Queue extends APIResource {
  slots: SlotsAPI.Slots = new SlotsAPI.Slots(this._client);

  /**
   * Get next available queue slot
   */
  getNextSlot(options?: RequestOptions): APIPromise<QueueGetNextSlotResponse> {
    return this._client.get('/v1/queue/next-slot', options);
  }

  /**
   * Preview upcoming queue slots
   */
  preview(
    query: QueuePreviewParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<QueuePreviewResponse> {
    return this._client.get('/v1/queue/preview', { query, ...options });
  }

  /**
   * Find best available posting slot using queue schedule, historical engagement
   * data, and collision avoidance.
   */
  findSlot(
    query: QueueFindSlotParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<QueueFindSlotResponse> {
    return this._client.get('/v1/queue/find-slot', { query, ...options });
  }
}

export interface QueueGetNextSlotResponse {
  /**
   * Next available slot (ISO 8601)
   */
  next_slot_at: string;

  /**
   * Queue schedule ID
   */
  queue_id: string;
}

export interface QueuePreviewResponse {
  /**
   * Upcoming slot timestamps (ISO 8601)
   */
  slots: Array<string>;
}

export interface QueuePreviewParams {
  /**
   * Number of upcoming slots to preview
   */
  count?: number;
}

export interface QueueFindSlotParams {
  /**
   * Account ID to optimize for
   */
  account_id?: string;

  /**
   * Earliest allowed time (ISO 8601). Defaults to now.
   */
  after?: string;

  /**
   * Algorithm strategy: queue (slots only), best-time (engagement only), or smart
   * (combined)
   */
  strategy?: 'queue' | 'best-time' | 'smart';

  /**
   * Number of slot suggestions to return (1-10)
   */
  count?: number;
}

export interface QueueFindSlotResponse {
  slots: Array<QueueFindSlotResponse.Slot>;

  /**
   * True if no ideal slot found, result is best-effort
   */
  fallback: boolean;
}

export namespace QueueFindSlotResponse {
  export interface Slot {
    /**
     * Suggested posting time (ISO 8601)
     */
    slot_at: string;

    /**
     * Confidence score 0-100
     */
    score: number;

    /**
     * Why this slot was suggested
     */
    reason: 'queue_slot' | 'best_time' | 'hybrid';

    /**
     * Number of existing posts at this time
     */
    conflicts: number;
  }
}

Queue.Slots = Slots;

export declare namespace Queue {
  export {
    type QueueGetNextSlotResponse as QueueGetNextSlotResponse,
    type QueuePreviewResponse as QueuePreviewResponse,
    type QueuePreviewParams as QueuePreviewParams,
    type QueueFindSlotParams as QueueFindSlotParams,
    type QueueFindSlotResponse as QueueFindSlotResponse,
  };

  export {
    Slots as Slots,
    type SlotCreateResponse as SlotCreateResponse,
    type SlotUpdateResponse as SlotUpdateResponse,
    type SlotListResponse as SlotListResponse,
    type SlotCreateParams as SlotCreateParams,
    type SlotUpdateParams as SlotUpdateParams,
  };
}
