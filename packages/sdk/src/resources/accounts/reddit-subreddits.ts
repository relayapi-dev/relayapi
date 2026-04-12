// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class RedditSubreddits extends APIResource {
  /**
   * Fetch Reddit subreddits for an account
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<RedditSubredditRetrieveResponse> {
    return this._client.get(path`/v1/accounts/${id}/reddit-subreddits`, options);
  }

  /**
   * Set default Reddit subreddit
   */
  setDefault(
    id: string,
    body: RedditSubredditSetDefaultParams,
    options?: RequestOptions,
  ): APIPromise<RedditSubredditSetDefaultResponse> {
    return this._client.put(path`/v1/accounts/${id}/reddit-subreddits`, { body, ...options });
  }
}

export interface RedditSubredditRetrieveResponse {
  data: Array<RedditSubredditRetrieveResponse.Data>;
}

export namespace RedditSubredditRetrieveResponse {
  export interface Data {
    display_name: string;

    name: string;

    subscribers: number | null;
  }
}

export interface RedditSubredditSetDefaultResponse {
  /**
   * Account ID
   */
  id: string;

  avatar_url: string | null;

  connected_at: string;

  display_name: string | null;

  metadata: { [key: string]: unknown } | null;

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

  platform_account_id: string;

  updated_at: string;

  username: string | null;
}

export interface RedditSubredditSetDefaultParams {
  /**
   * Subreddit name to set as default
   */
  subreddit: string;
}

export declare namespace RedditSubreddits {
  export {
    type RedditSubredditRetrieveResponse as RedditSubredditRetrieveResponse,
    type RedditSubredditSetDefaultResponse as RedditSubredditSetDefaultResponse,
    type RedditSubredditSetDefaultParams as RedditSubredditSetDefaultParams,
  };
}
