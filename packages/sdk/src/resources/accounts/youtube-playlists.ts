// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class YouTubePlaylists extends APIResource {
  /**
   * Fetch YouTube playlists for an account
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<YouTubePlaylistRetrieveResponse> {
    return this._client.get(path`/v1/accounts/${id}/youtube-playlists`, options);
  }

  /**
   * Set default YouTube playlist
   */
  setDefault(
    id: string,
    body: YouTubePlaylistSetDefaultParams,
    options?: RequestOptions,
  ): APIPromise<YouTubePlaylistSetDefaultResponse> {
    return this._client.put(path`/v1/accounts/${id}/youtube-playlists`, { body, ...options });
  }
}

export interface YouTubePlaylistRetrieveResponse {
  data: Array<YouTubePlaylistRetrieveResponse.Data>;
}

export namespace YouTubePlaylistRetrieveResponse {
  export interface Data {
    id: string;

    title: string;

    description: string | null;

    privacy: 'public' | 'private' | 'unlisted';

    item_count: number;

    thumbnail_url: string | null;
  }
}

export interface YouTubePlaylistSetDefaultResponse {
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

export interface YouTubePlaylistSetDefaultParams {
  /**
   * YouTube playlist ID to set as default
   */
  playlist_id: string;

  /**
   * Playlist name for display purposes
   */
  playlist_name?: string;
}

export declare namespace YouTubePlaylists {
  export {
    type YouTubePlaylistRetrieveResponse as YouTubePlaylistRetrieveResponse,
    type YouTubePlaylistSetDefaultResponse as YouTubePlaylistSetDefaultResponse,
    type YouTubePlaylistSetDefaultParams as YouTubePlaylistSetDefaultParams,
  };
}
