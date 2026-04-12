// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as YoutubeAPI from './youtube';
import { Youtube, YoutubeGetDailyViewsParams, YoutubeGetDailyViewsResponse } from './youtube';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';

export class Analytics extends APIResource {
  youtube: YoutubeAPI.Youtube = new YoutubeAPI.Youtube(this._client);

  /**
   * Get post analytics
   */
  retrieve(
    query: AnalyticsRetrieveParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AnalyticsRetrieveResponse> {
    return this._client.get('/v1/analytics', { query, ...options });
  }

  /**
   * Get best posting times based on engagement
   */
  getBestTime(
    query: AnalyticsGetBestTimeParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AnalyticsGetBestTimeResponse> {
    return this._client.get('/v1/analytics/best-time', { query, ...options });
  }

  /**
   * Get engagement decay curve for a post
   */
  getContentDecay(
    query: AnalyticsGetContentDecayParams,
    options?: RequestOptions,
  ): APIPromise<AnalyticsGetContentDecayResponse> {
    return this._client.get('/v1/analytics/content-decay', { query, ...options });
  }

  /**
   * Get per-post daily timeline of metrics
   */
  getPostTimeline(
    query: AnalyticsGetPostTimelineParams,
    options?: RequestOptions,
  ): APIPromise<AnalyticsGetPostTimelineResponse> {
    return this._client.get('/v1/analytics/post-timeline', { query, ...options });
  }

  /**
   * Get posting frequency vs engagement analysis
   */
  getPostingFrequency(
    query: AnalyticsGetPostingFrequencyParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AnalyticsGetPostingFrequencyResponse> {
    return this._client.get('/v1/analytics/posting-frequency', { query, ...options });
  }

  /**
   * Get daily aggregated metrics
   */
  listDailyMetrics(
    query: AnalyticsListDailyMetricsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AnalyticsListDailyMetricsResponse> {
    return this._client.get('/v1/analytics/daily-metrics', { query, ...options });
  }
}

export interface AnalyticsRetrieveResponse {
  data: Array<AnalyticsRetrieveResponse.Data>;

  overview?: AnalyticsRetrieveResponse.Overview;
}

export namespace AnalyticsRetrieveResponse {
  export interface Data {
    platform:
      | 'twitter'
      | 'instagram'
      | 'facebook'
      | 'linkedin'
      | 'tiktok'
      | 'youtube'
      | 'pinterest'
      | 'reddit'
      | 'bluesky'
      | 'threads'
      | 'telegram'
      | 'snapchat'
      | 'googlebusiness'
      | 'whatsapp'
      | 'mastodon'
      | 'discord'
      | 'sms';

    /**
     * Post ID
     */
    post_id: string;

    /**
     * Published timestamp
     */
    published_at: string;

    /**
     * Total clicks
     */
    clicks?: number | null;

    /**
     * Total comments
     */
    comments?: number | null;

    /**
     * Total impressions
     */
    impressions?: number | null;

    /**
     * Total likes
     */
    likes?: number | null;

    /**
     * Total reach
     */
    reach?: number | null;

    /**
     * Total saves
     */
    saves?: number | null;

    /**
     * Total shares
     */
    shares?: number | null;

    /**
     * Total views
     */
    views?: number | null;
  }

  export interface Overview {
    /**
     * Total clicks across posts
     */
    total_clicks: number;

    /**
     * Total comments across posts
     */
    total_comments: number;

    /**
     * Total impressions across posts
     */
    total_impressions: number;

    /**
     * Total likes across posts
     */
    total_likes: number;

    /**
     * Total number of posts
     */
    total_posts: number;

    /**
     * Total shares across posts
     */
    total_shares: number;

    /**
     * Total views across posts
     */
    total_views: number;
  }
}

export interface AnalyticsGetBestTimeResponse {
  data: Array<AnalyticsGetBestTimeResponse.Data>;
}

export namespace AnalyticsGetBestTimeResponse {
  export interface Data {
    /**
     * Average engagement score
     */
    avg_engagement: number;

    /**
     * Day of week (0=Sunday)
     */
    day_of_week: number;

    /**
     * Hour in UTC
     */
    hour_utc: number;

    /**
     * Number of posts analyzed
     */
    post_count: number;
  }
}

export interface AnalyticsGetContentDecayResponse {
  data: Array<AnalyticsGetContentDecayResponse.Data>;

  /**
   * Days until engagement halved
   */
  half_life_days: number | null;

  platform:
    | 'twitter'
    | 'instagram'
    | 'facebook'
    | 'linkedin'
    | 'tiktok'
    | 'youtube'
    | 'pinterest'
    | 'reddit'
    | 'bluesky'
    | 'threads'
    | 'telegram'
    | 'snapchat'
    | 'googlebusiness'
    | 'whatsapp'
    | 'mastodon'
    | 'discord'
    | 'sms';

  post_id: string;
}

export namespace AnalyticsGetContentDecayResponse {
  export interface Data {
    /**
     * Cumulative engagement
     */
    cumulative_engagement: number;

    /**
     * Cumulative impressions
     */
    cumulative_impressions: number;

    /**
     * Days since publication
     */
    day: number;

    /**
     * Engagement on this day
     */
    engagement: number;

    /**
     * Impressions on this day
     */
    impressions: number;
  }
}

export interface AnalyticsGetPostTimelineResponse {
  data: Array<AnalyticsGetPostTimelineResponse.Data>;

  post_id: string;
}

export namespace AnalyticsGetPostTimelineResponse {
  export interface Data {
    clicks: number;

    comments: number;

    /**
     * Date (YYYY-MM-DD)
     */
    date: string;

    impressions: number;

    likes: number;

    shares: number;

    views: number;
  }
}

export interface AnalyticsGetPostingFrequencyResponse {
  data: Array<AnalyticsGetPostingFrequencyResponse.Data>;

  /**
   * Recommended posts per week
   */
  optimal_frequency: number | null;
}

export namespace AnalyticsGetPostingFrequencyResponse {
  export interface Data {
    /**
     * Average engagement
     */
    avg_engagement: number;

    /**
     * Average impressions
     */
    avg_impressions: number;

    /**
     * Average posts per week in bucket
     */
    posts_per_week: number;

    /**
     * Number of weeks in sample
     */
    sample_weeks: number;
  }
}

export interface AnalyticsListDailyMetricsResponse {
  data: Array<AnalyticsListDailyMetricsResponse.Data>;
}

export namespace AnalyticsListDailyMetricsResponse {
  export interface Data {
    /**
     * Total clicks
     */
    clicks: number;

    /**
     * Total comments
     */
    comments: number;

    /**
     * Date (YYYY-MM-DD)
     */
    date: string;

    /**
     * Total impressions
     */
    impressions: number;

    /**
     * Total likes
     */
    likes: number;

    /**
     * Post count per platform
     */
    platforms: { [key: string]: number };

    /**
     * Posts published on this date
     */
    post_count: number;

    /**
     * Total shares
     */
    shares: number;

    /**
     * Total views
     */
    views: number;
  }
}

export interface AnalyticsRetrieveParams {
  /**
   * Filter by account ID
   */
  account_id?: string;

  /**
   * Start date (ISO 8601 date string)
   */
  from_date?: string;

  /**
   * Number of items
   */
  limit?: number;

  /**
   * Offset
   */
  offset?: number | null;

  /**
   * Filter by platform
   */
  platform?:
    | 'twitter'
    | 'instagram'
    | 'facebook'
    | 'linkedin'
    | 'tiktok'
    | 'youtube'
    | 'pinterest'
    | 'reddit'
    | 'bluesky'
    | 'threads'
    | 'telegram'
    | 'snapchat'
    | 'googlebusiness'
    | 'whatsapp'
    | 'mastodon'
    | 'discord'
    | 'sms';

  /**
   * Filter by post ID
   */
  post_id?: string;

  /**
   * End date (ISO 8601 date string)
   */
  to_date?: string;
}

export interface AnalyticsGetBestTimeParams {
  /**
   * Filter by account ID
   */
  account_id?: string;

  /**
   * Start date (ISO 8601)
   */
  from_date?: string;

  /**
   * Filter by platform
   */
  platform?:
    | 'twitter'
    | 'instagram'
    | 'facebook'
    | 'linkedin'
    | 'tiktok'
    | 'youtube'
    | 'pinterest'
    | 'reddit'
    | 'bluesky'
    | 'threads'
    | 'telegram'
    | 'snapchat'
    | 'googlebusiness'
    | 'whatsapp'
    | 'mastodon'
    | 'discord'
    | 'sms';

  /**
   * End date (ISO 8601)
   */
  to_date?: string;
}

export interface AnalyticsGetContentDecayParams {
  /**
   * Post ID to analyze decay for
   */
  post_id: string;

  /**
   * Number of days to analyze
   */
  days?: number;
}

export interface AnalyticsGetPostTimelineParams {
  /**
   * Post ID
   */
  post_id: string;

  /**
   * Start date (ISO 8601)
   */
  from_date?: string;

  /**
   * End date (ISO 8601)
   */
  to_date?: string;
}

export interface AnalyticsGetPostingFrequencyParams {
  /**
   * Filter by account ID
   */
  account_id?: string;

  /**
   * Start date (ISO 8601)
   */
  from_date?: string;

  /**
   * Filter by platform
   */
  platform?:
    | 'twitter'
    | 'instagram'
    | 'facebook'
    | 'linkedin'
    | 'tiktok'
    | 'youtube'
    | 'pinterest'
    | 'reddit'
    | 'bluesky'
    | 'threads'
    | 'telegram'
    | 'snapchat'
    | 'googlebusiness'
    | 'whatsapp'
    | 'mastodon'
    | 'discord'
    | 'sms';

  /**
   * End date (ISO 8601)
   */
  to_date?: string;
}

export interface AnalyticsListDailyMetricsParams {
  /**
   * Filter by account ID
   */
  account_id?: string;

  /**
   * Start date (ISO 8601)
   */
  from_date?: string;

  /**
   * Filter by platform
   */
  platform?:
    | 'twitter'
    | 'instagram'
    | 'facebook'
    | 'linkedin'
    | 'tiktok'
    | 'youtube'
    | 'pinterest'
    | 'reddit'
    | 'bluesky'
    | 'threads'
    | 'telegram'
    | 'snapchat'
    | 'googlebusiness'
    | 'whatsapp'
    | 'mastodon'
    | 'discord'
    | 'sms';

  /**
   * End date (ISO 8601)
   */
  to_date?: string;
}

Analytics.Youtube = Youtube;

export declare namespace Analytics {
  export {
    type AnalyticsRetrieveResponse as AnalyticsRetrieveResponse,
    type AnalyticsGetBestTimeResponse as AnalyticsGetBestTimeResponse,
    type AnalyticsGetContentDecayResponse as AnalyticsGetContentDecayResponse,
    type AnalyticsGetPostTimelineResponse as AnalyticsGetPostTimelineResponse,
    type AnalyticsGetPostingFrequencyResponse as AnalyticsGetPostingFrequencyResponse,
    type AnalyticsListDailyMetricsResponse as AnalyticsListDailyMetricsResponse,
    type AnalyticsRetrieveParams as AnalyticsRetrieveParams,
    type AnalyticsGetBestTimeParams as AnalyticsGetBestTimeParams,
    type AnalyticsGetContentDecayParams as AnalyticsGetContentDecayParams,
    type AnalyticsGetPostTimelineParams as AnalyticsGetPostTimelineParams,
    type AnalyticsGetPostingFrequencyParams as AnalyticsGetPostingFrequencyParams,
    type AnalyticsListDailyMetricsParams as AnalyticsListDailyMetricsParams,
  };

  export {
    Youtube as Youtube,
    type YoutubeGetDailyViewsResponse as YoutubeGetDailyViewsResponse,
    type YoutubeGetDailyViewsParams as YoutubeGetDailyViewsParams,
  };
}
