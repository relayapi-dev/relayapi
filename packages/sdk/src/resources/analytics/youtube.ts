// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';

export class Youtube extends APIResource {
  /**
   * Get YouTube daily views and watch time
   */
  getDailyViews(
    query: YoutubeGetDailyViewsParams,
    options?: RequestOptions,
  ): APIPromise<YoutubeGetDailyViewsResponse> {
    return this._client.get('/v1/analytics/youtube/daily-views', { query, ...options });
  }
}

export interface YoutubeGetDailyViewsResponse {
  data: Array<YoutubeGetDailyViewsResponse.Data>;
}

export namespace YoutubeGetDailyViewsResponse {
  export interface Data {
    /**
     * Date (YYYY-MM-DD)
     */
    date: string;

    /**
     * Net subscribers gained
     */
    subscribers_gained: number;

    /**
     * Total views
     */
    views: number;

    /**
     * Watch time in minutes
     */
    watch_time_minutes: number;
  }
}

export interface YoutubeGetDailyViewsParams {
  /**
   * YouTube account ID
   */
  account_id: string;

  /**
   * Start date (ISO 8601)
   */
  from_date?: string;

  /**
   * End date (ISO 8601)
   */
  to_date?: string;
}

export declare namespace Youtube {
  export {
    type YoutubeGetDailyViewsResponse as YoutubeGetDailyViewsResponse,
    type YoutubeGetDailyViewsParams as YoutubeGetDailyViewsParams,
  };
}
