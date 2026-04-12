// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';

export class Validate extends APIResource {
  /**
   * Check character counts against platform limits
   *
   * @example
   * ```ts
   * const response =
   *   await client.tools.validate.checkPostLength({
   *     content: 'content',
   *   });
   * ```
   */
  checkPostLength(
    body: ValidateCheckPostLengthParams,
    options?: RequestOptions,
  ): APIPromise<ValidateCheckPostLengthResponse> {
    return this._client.post('/v1/tools/validate/post-length', { body, ...options });
  }

  /**
   * Check if a subreddit exists and get its details
   *
   * @example
   * ```ts
   * const response =
   *   await client.tools.validate.retrieveSubreddit({
   *     name: 'name',
   *   });
   * ```
   */
  retrieveSubreddit(
    query: ValidateRetrieveSubredditParams,
    options?: RequestOptions,
  ): APIPromise<ValidateRetrieveSubredditResponse> {
    return this._client.get('/v1/tools/validate/subreddit', { query, ...options });
  }

  /**
   * Validate a media URL for platform compatibility
   *
   * @example
   * ```ts
   * const response = await client.tools.validate.validateMedia({
   *   url: 'https://example.com',
   * });
   * ```
   */
  validateMedia(
    body: ValidateValidateMediaParams,
    options?: RequestOptions,
  ): APIPromise<ValidateValidateMediaResponse> {
    return this._client.post('/v1/tools/validate/media', { body, ...options });
  }

  /**
   * Validate a post (dry-run without publishing)
   *
   * @example
   * ```ts
   * const response = await client.tools.validate.validatePost({
   *   scheduled_at: 'now',
   *   targets: ['string'],
   * });
   * ```
   */
  validatePost(
    body: ValidateValidatePostParams,
    options?: RequestOptions,
  ): APIPromise<ValidateValidatePostResponse> {
    return this._client.post('/v1/tools/validate/post', { body, ...options });
  }
}

export interface ValidateCheckPostLengthResponse {
  /**
   * Character count per platform
   */
  platforms: ValidateCheckPostLengthResponse.Platforms;
}

export namespace ValidateCheckPostLengthResponse {
  /**
   * Character count per platform
   */
  export interface Platforms {
    bluesky?: Platforms.Bluesky;

    discord?: Platforms.Discord;

    facebook?: Platforms.Facebook;

    googlebusiness?: Platforms.Googlebusiness;

    instagram?: Platforms.Instagram;

    linkedin?: Platforms.Linkedin;

    mastodon?: Platforms.Mastodon;

    pinterest?: Platforms.Pinterest;

    reddit?: Platforms.Reddit;

    sms?: Platforms.SMS;

    snapchat?: Platforms.Snapchat;

    telegram?: Platforms.Telegram;

    threads?: Platforms.Threads;

    tiktok?: Platforms.Tiktok;

    twitter?: Platforms.Twitter;

    whatsapp?: Platforms.Whatsapp;

    youtube?: Platforms.Youtube;
  }

  export namespace Platforms {
    export interface Bluesky {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface Discord {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface Facebook {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface Googlebusiness {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface Instagram {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface Linkedin {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface Mastodon {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface Pinterest {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface Reddit {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface SMS {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface Snapchat {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface Telegram {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface Threads {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface Tiktok {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface Twitter {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface Whatsapp {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }

    export interface Youtube {
      /**
       * Character count for this platform
       */
      count: number;

      /**
       * Character limit for this platform
       */
      limit: number;

      /**
       * Whether content is within limit
       */
      within_limit: boolean;
    }
  }
}

export interface ValidateRetrieveSubredditResponse {
  /**
   * Whether the subreddit exists
   */
  exists: boolean;

  /**
   * Canonical subreddit name
   */
  name?: string | null;

  /**
   * Whether NSFW
   */
  nsfw?: boolean | null;

  /**
   * Allowed post types
   */
  post_types?: ValidateRetrieveSubredditResponse.PostTypes;

  /**
   * Subscriber count
   */
  subscribers?: number | null;

  /**
   * Subreddit title
   */
  title?: string | null;
}

export namespace ValidateRetrieveSubredditResponse {
  /**
   * Allowed post types
   */
  export interface PostTypes {
    /**
     * Allows image posts
     */
    image: boolean;

    /**
     * Allows link posts
     */
    link: boolean;

    /**
     * Allows text posts
     */
    self: boolean;
  }
}

export interface ValidateValidateMediaResponse {
  /**
   * Whether the URL is accessible
   */
  accessible: boolean;

  /**
   * Per-platform size limits
   */
  platform_limits: ValidateValidateMediaResponse.PlatformLimits;

  /**
   * MIME type
   */
  content_type?: string | null;

  /**
   * File size in bytes
   */
  size?: number | null;
}

export namespace ValidateValidateMediaResponse {
  /**
   * Per-platform size limits
   */
  export interface PlatformLimits {
    bluesky?: PlatformLimits.Bluesky;

    discord?: PlatformLimits.Discord;

    facebook?: PlatformLimits.Facebook;

    googlebusiness?: PlatformLimits.Googlebusiness;

    instagram?: PlatformLimits.Instagram;

    linkedin?: PlatformLimits.Linkedin;

    mastodon?: PlatformLimits.Mastodon;

    pinterest?: PlatformLimits.Pinterest;

    reddit?: PlatformLimits.Reddit;

    sms?: PlatformLimits.SMS;

    snapchat?: PlatformLimits.Snapchat;

    telegram?: PlatformLimits.Telegram;

    threads?: PlatformLimits.Threads;

    tiktok?: PlatformLimits.Tiktok;

    twitter?: PlatformLimits.Twitter;

    whatsapp?: PlatformLimits.Whatsapp;

    youtube?: PlatformLimits.Youtube;
  }

  export namespace PlatformLimits {
    export interface Bluesky {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface Discord {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface Facebook {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface Googlebusiness {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface Instagram {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface Linkedin {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface Mastodon {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface Pinterest {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface Reddit {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface SMS {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface Snapchat {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface Telegram {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface Threads {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface Tiktok {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface Twitter {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface Whatsapp {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }

    export interface Youtube {
      /**
       * Maximum file size in bytes
       */
      max_size: number;

      /**
       * Whether file size is within limit
       */
      within_limit: boolean;
    }
  }
}

export interface ValidateValidatePostResponse {
  /**
   * Blocking errors
   */
  errors: Array<ValidateValidatePostResponse.Error>;

  /**
   * Whether the post is valid for all targets
   */
  valid: boolean;

  /**
   * Non-blocking warnings
   */
  warnings: Array<ValidateValidatePostResponse.Warning>;
}

export namespace ValidateValidatePostResponse {
  export interface Error {
    /**
     * Error code
     */
    code: string;

    /**
     * Human-readable error message
     */
    message: string;

    /**
     * Target identifier (account ID, platform, or field name)
     */
    target: string;
  }

  export interface Warning {
    /**
     * Error code
     */
    code: string;

    /**
     * Human-readable error message
     */
    message: string;

    /**
     * Target identifier (account ID, platform, or field name)
     */
    target: string;
  }
}

export interface ValidateCheckPostLengthParams {
  /**
   * Post content to check
   */
  content: string;
}

export interface ValidateRetrieveSubredditParams {
  /**
   * Subreddit name (without r/ prefix)
   */
  name: string;
}

export interface ValidateValidateMediaParams {
  /**
   * Media URL to validate
   */
  url: string;
}

export interface ValidateValidatePostParams {
  /**
   * Publish intent. Use "now" to publish immediately, "draft" to save as draft, or
   * an ISO 8601 timestamp to schedule.
   */
  scheduled_at: string;

  /**
   * Account IDs or platform names to publish to
   */
  targets: Array<string>;

  /**
   * Post text. Optional if target_options provide per-target content.
   */
  content?: string;

  /**
   * Media attachments
   */
  media?: Array<ValidateValidatePostParams.Media>;

  /**
   * Per-target customizations keyed by target value (account ID or platform name)
   */
  target_options?: { [key: string]: { [key: string]: unknown } };

  /**
   * IANA timezone for scheduling
   */
  timezone?: string;
}

export namespace ValidateValidatePostParams {
  export interface Media {
    /**
     * Public URL of the media file
     */
    url: string;

    /**
     * Media type. Inferred from URL extension if omitted.
     */
    type?: 'image' | 'video' | 'gif' | 'document';
  }
}

export declare namespace Validate {
  export {
    type ValidateCheckPostLengthResponse as ValidateCheckPostLengthResponse,
    type ValidateRetrieveSubredditResponse as ValidateRetrieveSubredditResponse,
    type ValidateValidateMediaResponse as ValidateValidateMediaResponse,
    type ValidateValidatePostResponse as ValidateValidatePostResponse,
    type ValidateCheckPostLengthParams as ValidateCheckPostLengthParams,
    type ValidateRetrieveSubredditParams as ValidateRetrieveSubredditParams,
    type ValidateValidateMediaParams as ValidateValidateMediaParams,
    type ValidateValidatePostParams as ValidateValidatePostParams,
  };
}
