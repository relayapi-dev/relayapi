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

  /**
   * Get cross-channel analytics summaries for connected accounts
   */
  listChannels(
    query: AnalyticsListChannelsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AnalyticsListChannelsResponse> {
    return this._client.get('/v1/analytics/channels', { query, ...options });
  }

  /**
   * Get live platform overview metrics for a single account
   */
  getPlatformOverview(
    query: AnalyticsGetPlatformOverviewParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AnalyticsGetPlatformOverviewResponse> {
    return this._client.get('/v1/analytics/platform/overview', { query, ...options });
  }

  /**
   * Get top posts for a single account from the native platform API
   */
  listPlatformPosts(
    query: AnalyticsListPlatformPostsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AnalyticsListPlatformPostsResponse> {
    return this._client.get('/v1/analytics/platform/posts', { query, ...options });
  }

  /**
   * Get audience breakdowns for a single account from the native platform API
   */
  getPlatformAudience(
    query: AnalyticsGetPlatformAudienceParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AnalyticsGetPlatformAudienceResponse> {
    return this._client.get('/v1/analytics/platform/audience', { query, ...options });
  }

  /**
   * Get daily native platform metrics for a single account
   */
  getPlatformDaily(
    query: AnalyticsGetPlatformDailyParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AnalyticsGetPlatformDailyResponse> {
    return this._client.get('/v1/analytics/platform/daily', { query, ...options });
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

export interface AnalyticsListChannelsResponse {
  data: Array<AnalyticsListChannelsResponse.Data>;

  totals: AnalyticsListChannelsResponse.Totals;
}

export namespace AnalyticsListChannelsResponse {
  export interface Data {
    account_id: string;

    avatar_url: string | null;

    display_name: string | null;

    engagement_rate: number | null;

    followers: number | null;

    has_analytics: boolean;

    impressions: number | null;

    needs_reconnect: boolean;

    platform: string;

    username: string | null;
  }

  export interface Totals {
    audience_change: number | null;

    engagement_change: number | null;

    impressions_change: number | null;

    total_audience: number;

    total_engagement: number;

    total_impressions: number;
  }
}

export interface AnalyticsGetPlatformOverviewResponse {
  engagement: number | null;

  engagement_change: number | null;

  engagement_rate: number | null;

  follower_change: number | null;

  followers: number | null;

  impression_change: number | null;

  impressions: number | null;

  platform_specific: { [key: string]: string | number | null };

  posts_count: number | null;

  reach: number | null;

  reach_change: number | null;
}

export interface AnalyticsListPlatformPostsResponse {
  data: Array<AnalyticsListPlatformPostsResponse.Data>;
}

export namespace AnalyticsListPlatformPostsResponse {
  export interface Data {
    clicks: number;

    comments: number;

    content: string | null;

    engagement_rate: number;

    impressions: number;

    likes: number;

    media_type: string | null;

    media_url: string | null;

    platform_post_id: string;

    platform_url: string | null;

    published_at: string;

    reach: number;

    saves: number;

    shares: number;
  }
}

export interface AnalyticsGetPlatformAudienceResponse {
  age_gender: Array<AnalyticsGetPlatformAudienceResponse.AgeGender>;

  available: boolean;

  top_cities: Array<AnalyticsGetPlatformAudienceResponse.TopCity>;

  top_countries: Array<AnalyticsGetPlatformAudienceResponse.TopCountry>;
}

export namespace AnalyticsGetPlatformAudienceResponse {
  export interface AgeGender {
    age_range: string;

    female: number;

    male: number;

    other: number;
  }

  export interface TopCity {
    count: number;

    name: string;
  }

  export interface TopCountry {
    code: string;

    count: number;

    name: string;
  }
}

export interface AnalyticsGetPlatformDailyResponse {
  data: Array<AnalyticsGetPlatformDailyResponse.Data>;
}

export namespace AnalyticsGetPlatformDailyResponse {
  export interface Data {
    date: string;

    engagement: number;

    followers: number;

    impressions: number;

    reach: number;
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

export interface AnalyticsListChannelsParams {
  from_date?: string;

  to_date?: string;
}

export interface AnalyticsGetPlatformOverviewParams {
  account_id?: string;

  from_date?: string;

  to_date?: string;
}

export interface AnalyticsListPlatformPostsParams {
  account_id?: string;

  from_date?: string;

  limit?: number;

  to_date?: string;
}

export interface AnalyticsGetPlatformAudienceParams {
  account_id?: string;

  from_date?: string;

  to_date?: string;
}

export interface AnalyticsGetPlatformDailyParams {
  account_id?: string;

  from_date?: string;

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
    type AnalyticsListChannelsResponse as AnalyticsListChannelsResponse,
    type AnalyticsGetPlatformOverviewResponse as AnalyticsGetPlatformOverviewResponse,
    type AnalyticsListPlatformPostsResponse as AnalyticsListPlatformPostsResponse,
    type AnalyticsGetPlatformAudienceResponse as AnalyticsGetPlatformAudienceResponse,
    type AnalyticsGetPlatformDailyResponse as AnalyticsGetPlatformDailyResponse,
    type AnalyticsRetrieveParams as AnalyticsRetrieveParams,
    type AnalyticsGetBestTimeParams as AnalyticsGetBestTimeParams,
    type AnalyticsGetContentDecayParams as AnalyticsGetContentDecayParams,
    type AnalyticsGetPostTimelineParams as AnalyticsGetPostTimelineParams,
    type AnalyticsGetPostingFrequencyParams as AnalyticsGetPostingFrequencyParams,
    type AnalyticsListDailyMetricsParams as AnalyticsListDailyMetricsParams,
    type AnalyticsListChannelsParams as AnalyticsListChannelsParams,
    type AnalyticsGetPlatformOverviewParams as AnalyticsGetPlatformOverviewParams,
    type AnalyticsListPlatformPostsParams as AnalyticsListPlatformPostsParams,
    type AnalyticsGetPlatformAudienceParams as AnalyticsGetPlatformAudienceParams,
    type AnalyticsGetPlatformDailyParams as AnalyticsGetPlatformDailyParams,
  };

  export {
    Youtube as Youtube,
    type YoutubeGetDailyViewsResponse as YoutubeGetDailyViewsResponse,
    type YoutubeGetDailyViewsParams as YoutubeGetDailyViewsParams,
  };
}
