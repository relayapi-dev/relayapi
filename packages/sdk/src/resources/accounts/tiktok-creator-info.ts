// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class TikTokCreatorInfo extends APIResource {
  /**
   * Fetch TikTok creator info (available privacy levels, posting limits)
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<TikTokCreatorInfoRetrieveResponse> {
    return this._client.get(path`/v1/accounts/${id}/tiktok-creator-info`, options);
  }
}

export interface TikTokCreatorInfoRetrieveResponse {
  /**
   * Creator avatar URL
   */
  creator_avatar_url: string;

  /**
   * Creator username
   */
  creator_username: string;

  /**
   * Creator display name
   */
  creator_nickname: string;

  /**
   * Available privacy levels for this account
   */
  privacy_level_options: Array<string>;

  /**
   * Whether comments are disabled by default
   */
  comment_disabled: boolean;

  /**
   * Whether duets are disabled by default
   */
  duet_disabled: boolean;

  /**
   * Whether stitches are disabled by default
   */
  stitch_disabled: boolean;

  /**
   * Maximum video duration in seconds
   */
  max_video_post_duration_sec: number;
}

export declare namespace TikTokCreatorInfo {
  export {
    type TikTokCreatorInfoRetrieveResponse as TikTokCreatorInfoRetrieveResponse,
  };
}
