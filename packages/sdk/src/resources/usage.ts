// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';

export class Usage extends APIResource {
  /**
   * Returns current plan details and API call usage statistics for the organization.
   */
  retrieve(options?: RequestOptions): APIPromise<UsageRetrieveResponse> {
    return this._client.get('/v1/usage', options);
  }

  /**
   * Returns per-request API logs for the organization, ordered by most recent first.
   */
  listLogs(
    query: UsageListLogsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<UsageListLogsResponse> {
    return this._client.get('/v1/usage/logs', { query, ...options });
  }
}

export interface UsageRetrieveResponse {
  plan: UsageRetrieveResponse.Plan;

  rate_limit: UsageRetrieveResponse.RateLimit;

  subscription: UsageRetrieveResponse.Subscription;

  usage: UsageRetrieveResponse.Usage;
}

export namespace UsageRetrieveResponse {
  export interface Plan {
    /**
     * API calls included per billing cycle
     */
    api_calls_limit: number;

    /**
     * API calls allowed per minute
     */
    api_calls_per_min: number;

    features: Plan.Features;

    /**
     * Current plan
     */
    name: 'free' | 'pro';
  }

  export namespace Plan {
    export interface Features {
      /**
       * Access to /v1/analytics
       */
      analytics: boolean;

      /**
       * Access to /v1/inbox
       */
      inbox: boolean;
    }
  }

  export interface RateLimit {
    /**
     * API calls in the current rate-limit window
     */
    current_minute: number;

    /**
     * Max API calls per rate-limit window
     */
    limit_per_minute: number;
  }

  export interface Subscription {
    /**
     * Base monthly price in cents
     */
    monthly_price_cents: number;

    /**
     * Overage price per 1K API calls in cents
     */
    price_per_thousand_calls_cents: number;

    /**
     * Subscription status
     */
    status: string;
  }

  export interface Usage {
    /**
     * API calls remaining this cycle. Null for pro plan (unlimited, overage billed).
     */
    api_calls_remaining: number | null;

    /**
     * API calls used this cycle
     */
    api_calls_used: number;

    /**
     * Current billing cycle end
     */
    cycle_end: string;

    /**
     * Current billing cycle start
     */
    cycle_start: string;

    /**
     * API calls exceeding included amount
     */
    overage_calls: number;

    /**
     * Overage cost in cents
     */
    overage_cost_cents: number;
  }
}

export interface UsageListLogsResponse {
  data: Array<UsageListLogsResponse.Data>;

  has_more: boolean;

  next_cursor: string | null;

  total: number;
}

export namespace UsageListLogsResponse {
  export interface Data {
    billable: boolean;

    created_at: string;

    id: string;

    method: string;

    path: string;

    response_time_ms: number;

    status_code: number;
  }
}

export interface UsageListLogsParams {
  cursor?: string;

  from?: string;

  limit?: number;

  to?: string;
}

export declare namespace Usage {
  export {
    type UsageRetrieveResponse as UsageRetrieveResponse,
    type UsageListLogsResponse as UsageListLogsResponse,
    type UsageListLogsParams as UsageListLogsParams,
  };
}
