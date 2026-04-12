// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as FacebookPagesAPI from './facebook-pages';
import {
  FacebookPageRetrieveResponse,
  FacebookPageSetDefaultParams,
  FacebookPageSetDefaultResponse,
  FacebookPages,
} from './facebook-pages';
import * as GmbAttributesAPI from './gmb-attributes';
import { GmbAttributeRetrieveResponse, GmbAttributeUpdateParams, GmbAttributeUpdateResponse, GmbAttributes } from './gmb-attributes';
import * as GmbFoodMenusAPI from './gmb-food-menus';
import { GmbFoodMenuRetrieveResponse, GmbFoodMenuUpdateParams, GmbFoodMenuUpdateResponse, GmbFoodMenus } from './gmb-food-menus';
import * as GmbLocationDetailsAPI from './gmb-location-details';
import {
  GmbLocationDetailRetrieveParams,
  GmbLocationDetailRetrieveResponse,
  GmbLocationDetailUpdateParams,
  GmbLocationDetailUpdateResponse,
  GmbLocationDetails,
} from './gmb-location-details';
import * as GmbLocationsAPI from './gmb-locations';
import {
  GmbLocationRetrieveResponse,
  GmbLocationSetDefaultParams,
  GmbLocationSetDefaultResponse,
  GmbLocations,
} from './gmb-locations';
import * as GmbMediaAPI from './gmb-media';
import {
  GmbMedia,
  GmbMediaCategory,
  GmbMediaDeleteParams,
  GmbMediaDeleteResponse,
  GmbMediaListResponse,
  GmbMediaUploadParams,
  GmbMediaUploadResponse,
} from './gmb-media';
import * as GmbPlaceActionsAPI from './gmb-place-actions';
import {
  GmbPlaceActionCreateParams,
  GmbPlaceActionCreateResponse,
  GmbPlaceActionDeleteParams,
  GmbPlaceActionDeleteResponse,
  GmbPlaceActionListResponse,
  GmbPlaceActionType,
  GmbPlaceActions,
} from './gmb-place-actions';
import * as HealthAPI from './health';
import { Health, HealthListResponse, HealthRetrieveResponse } from './health';
import * as LinkedinOrganizationsAPI from './linkedin-organizations';
import {
  LinkedinOrganizationRetrieveResponse,
  LinkedinOrganizationSwitchTypeParams,
  LinkedinOrganizationSwitchTypeResponse,
  LinkedinOrganizations,
} from './linkedin-organizations';
import * as PinterestBoardsAPI from './pinterest-boards';
import {
  PinterestBoardRetrieveResponse,
  PinterestBoardSetDefaultParams,
  PinterestBoardSetDefaultResponse,
  PinterestBoards,
} from './pinterest-boards';
import * as RedditFlairsAPI from './reddit-flairs';
import { RedditFlairRetrieveParams, RedditFlairRetrieveResponse, RedditFlairs } from './reddit-flairs';
import * as RedditSubredditsAPI from './reddit-subreddits';
import {
  RedditSubredditRetrieveResponse,
  RedditSubredditSetDefaultParams,
  RedditSubredditSetDefaultResponse,
  RedditSubreddits,
} from './reddit-subreddits';
import * as TikTokCreatorInfoAPI from './tiktok-creator-info';
import { TikTokCreatorInfo, TikTokCreatorInfoRetrieveResponse } from './tiktok-creator-info';
import * as YouTubePlaylistsAPI from './youtube-playlists';
import {
  YouTubePlaylistRetrieveResponse,
  YouTubePlaylistSetDefaultParams,
  YouTubePlaylistSetDefaultResponse,
  YouTubePlaylists,
} from './youtube-playlists';
import { APIPromise } from '../../core/api-promise';
import { buildHeaders } from '../../internal/headers';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Accounts extends APIResource {
  health: HealthAPI.Health = new HealthAPI.Health(this._client);
  redditFlairs: RedditFlairsAPI.RedditFlairs = new RedditFlairsAPI.RedditFlairs(this._client);
  facebookPages: FacebookPagesAPI.FacebookPages = new FacebookPagesAPI.FacebookPages(this._client);
  linkedinOrganizations: LinkedinOrganizationsAPI.LinkedinOrganizations =
    new LinkedinOrganizationsAPI.LinkedinOrganizations(this._client);
  pinterestBoards: PinterestBoardsAPI.PinterestBoards = new PinterestBoardsAPI.PinterestBoards(this._client);
  redditSubreddits: RedditSubredditsAPI.RedditSubreddits = new RedditSubredditsAPI.RedditSubreddits(
    this._client,
  );
  gmbLocations: GmbLocationsAPI.GmbLocations = new GmbLocationsAPI.GmbLocations(this._client);
  gmbFoodMenus: GmbFoodMenusAPI.GmbFoodMenus = new GmbFoodMenusAPI.GmbFoodMenus(this._client);
  gmbLocationDetails: GmbLocationDetailsAPI.GmbLocationDetails = new GmbLocationDetailsAPI.GmbLocationDetails(this._client);
  gmbMedia: GmbMediaAPI.GmbMedia = new GmbMediaAPI.GmbMedia(this._client);
  gmbAttributes: GmbAttributesAPI.GmbAttributes = new GmbAttributesAPI.GmbAttributes(this._client);
  gmbPlaceActions: GmbPlaceActionsAPI.GmbPlaceActions = new GmbPlaceActionsAPI.GmbPlaceActions(this._client);
  tiktokCreatorInfo: TikTokCreatorInfoAPI.TikTokCreatorInfo = new TikTokCreatorInfoAPI.TikTokCreatorInfo(
    this._client,
  );
  youtubePlaylists: YouTubePlaylistsAPI.YouTubePlaylists = new YouTubePlaylistsAPI.YouTubePlaylists(
    this._client,
  );

  /**
   * Get a connected account
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<AccountRetrieveResponse> {
    return this._client.get(path`/v1/accounts/${id}`, options);
  }

  /**
   * Update account metadata
   */
  update(
    id: string,
    body: AccountUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AccountUpdateResponse> {
    return this._client.patch(path`/v1/accounts/${id}`, { body, ...options });
  }

  /**
   * List connected accounts
   */
  list(
    query: AccountListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AccountListResponse> {
    return this._client.get('/v1/accounts', { query, ...options });
  }

  /**
   * Get newsletter lists/audiences for a newsletter account (beehiiv, convertkit,
   * mailchimp, listmonk).
   */
  listNewsletterLists(id: string, options?: RequestOptions): APIPromise<NewsletterListsResponse> {
    return this._client.get(path`/v1/accounts/${id}/lists`, options);
  }

  /**
   * Get newsletter templates for a newsletter account (mailchimp, listmonk).
   */
  listNewsletterTemplates(id: string, options?: RequestOptions): APIPromise<NewsletterTemplatesResponse> {
    return this._client.get(path`/v1/accounts/${id}/templates`, options);
  }

  /**
   * Trigger post sync for a single account
   */
  sync(id: string, options?: RequestOptions): APIPromise<AccountSyncResponse> {
    return this._client.post(path`/v1/accounts/${id}/sync`, options);
  }

  /**
   * Disconnect a social account
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/accounts/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface AccountWorkspace {
  id: string;
  name: string;
}

export interface AccountRetrieveResponse {
  /**
   * Account ID
   */
  id: string;

  avatar_url: string | null;

  connected_at: string;

  display_name: string | null;

  metadata: { [key: string]: unknown } | null;

  workspace: AccountWorkspace | null;

  /**
   * Per-account scheduling preferences for smart slot finding.
   */
  scheduling_preferences?: {
    posting_windows?: Array<{ day_of_week: number; start_hour: number; end_hour: number }>;
    max_posts_per_day?: number;
    min_gap_minutes?: number;
  } | null;

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
    | 'sms'
    | 'beehiiv'
    | 'convertkit'
    | 'mailchimp'
    | 'listmonk';

  platform_account_id: string;

  updated_at: string;

  username: string | null;
}

export interface AccountUpdateResponse {
  /**
   * Account ID
   */
  id: string;

  avatar_url: string | null;

  connected_at: string;

  display_name: string | null;

  metadata: { [key: string]: unknown } | null;

  workspace: AccountWorkspace | null;

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

export interface AccountListResponse {
  data: Array<AccountListResponse.Data>;

  /**
   * Whether more items exist
   */
  has_more: boolean;

  /**
   * Cursor for next page
   */
  next_cursor: string | null;
}

export namespace AccountListResponse {
  export interface Data {
    /**
     * Account ID
     */
    id: string;

    avatar_url: string | null;

    connected_at: string;

    display_name: string | null;

    metadata: { [key: string]: unknown } | null;

    workspace: AccountWorkspace | null;

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
}

export interface AccountSyncResponse {
  success: boolean;
}

export interface AccountUpdateParams {
  display_name?: string;

  metadata?: { [key: string]: unknown };

  /**
   * Group ID (null to ungroup)
   */
  workspace_id?: string | null;
}

export interface AccountListParams {
  /**
   * Pagination cursor
   */
  cursor?: string;

  /**
   * Number of items per page
   */
  limit?: number;

  /**
   * Filter by group ID
   */
  workspace_id?: string;

  /**
   * Only show ungrouped accounts
   */
  ungrouped?: boolean;
}

Accounts.Health = Health;
Accounts.RedditFlairs = RedditFlairs;
Accounts.FacebookPages = FacebookPages;
Accounts.LinkedinOrganizations = LinkedinOrganizations;
Accounts.PinterestBoards = PinterestBoards;
Accounts.RedditSubreddits = RedditSubreddits;
Accounts.GmbLocations = GmbLocations;
Accounts.GmbFoodMenus = GmbFoodMenus;
Accounts.GmbLocationDetails = GmbLocationDetails;
Accounts.GmbMedia = GmbMedia;
Accounts.GmbAttributes = GmbAttributes;
Accounts.GmbPlaceActions = GmbPlaceActions;
Accounts.YouTubePlaylists = YouTubePlaylists;

export declare namespace Accounts {
  export {
    type AccountRetrieveResponse as AccountRetrieveResponse,
    type AccountUpdateResponse as AccountUpdateResponse,
    type AccountListResponse as AccountListResponse,
    type AccountSyncResponse as AccountSyncResponse,
    type AccountUpdateParams as AccountUpdateParams,
    type AccountListParams as AccountListParams,
  };

  export {
    Health as Health,
    type HealthRetrieveResponse as HealthRetrieveResponse,
    type HealthListResponse as HealthListResponse,
  };

  export {
    RedditFlairs as RedditFlairs,
    type RedditFlairRetrieveResponse as RedditFlairRetrieveResponse,
    type RedditFlairRetrieveParams as RedditFlairRetrieveParams,
  };

  export {
    FacebookPages as FacebookPages,
    type FacebookPageRetrieveResponse as FacebookPageRetrieveResponse,
    type FacebookPageSetDefaultResponse as FacebookPageSetDefaultResponse,
    type FacebookPageSetDefaultParams as FacebookPageSetDefaultParams,
  };

  export {
    LinkedinOrganizations as LinkedinOrganizations,
    type LinkedinOrganizationRetrieveResponse as LinkedinOrganizationRetrieveResponse,
    type LinkedinOrganizationSwitchTypeResponse as LinkedinOrganizationSwitchTypeResponse,
    type LinkedinOrganizationSwitchTypeParams as LinkedinOrganizationSwitchTypeParams,
  };

  export {
    PinterestBoards as PinterestBoards,
    type PinterestBoardRetrieveResponse as PinterestBoardRetrieveResponse,
    type PinterestBoardSetDefaultResponse as PinterestBoardSetDefaultResponse,
    type PinterestBoardSetDefaultParams as PinterestBoardSetDefaultParams,
  };

  export {
    RedditSubreddits as RedditSubreddits,
    type RedditSubredditRetrieveResponse as RedditSubredditRetrieveResponse,
    type RedditSubredditSetDefaultResponse as RedditSubredditSetDefaultResponse,
    type RedditSubredditSetDefaultParams as RedditSubredditSetDefaultParams,
  };

  export {
    GmbLocations as GmbLocations,
    type GmbLocationRetrieveResponse as GmbLocationRetrieveResponse,
    type GmbLocationSetDefaultResponse as GmbLocationSetDefaultResponse,
    type GmbLocationSetDefaultParams as GmbLocationSetDefaultParams,
  };

  export {
    GmbFoodMenus as GmbFoodMenus,
    type GmbFoodMenuRetrieveResponse as GmbFoodMenuRetrieveResponse,
    type GmbFoodMenuUpdateResponse as GmbFoodMenuUpdateResponse,
    type GmbFoodMenuUpdateParams as GmbFoodMenuUpdateParams,
  };

  export {
    GmbLocationDetails as GmbLocationDetails,
    type GmbLocationDetailRetrieveResponse as GmbLocationDetailRetrieveResponse,
    type GmbLocationDetailUpdateResponse as GmbLocationDetailUpdateResponse,
    type GmbLocationDetailRetrieveParams as GmbLocationDetailRetrieveParams,
    type GmbLocationDetailUpdateParams as GmbLocationDetailUpdateParams,
  };

  export {
    GmbMedia as GmbMedia,
    type GmbMediaListResponse as GmbMediaListResponse,
    type GmbMediaUploadResponse as GmbMediaUploadResponse,
    type GmbMediaDeleteResponse as GmbMediaDeleteResponse,
    type GmbMediaCategory as GmbMediaCategory,
    type GmbMediaUploadParams as GmbMediaUploadParams,
    type GmbMediaDeleteParams as GmbMediaDeleteParams,
  };

  export {
    GmbAttributes as GmbAttributes,
    type GmbAttributeRetrieveResponse as GmbAttributeRetrieveResponse,
    type GmbAttributeUpdateResponse as GmbAttributeUpdateResponse,
    type GmbAttributeUpdateParams as GmbAttributeUpdateParams,
  };

  export {
    GmbPlaceActions as GmbPlaceActions,
    type GmbPlaceActionListResponse as GmbPlaceActionListResponse,
    type GmbPlaceActionCreateResponse as GmbPlaceActionCreateResponse,
    type GmbPlaceActionDeleteResponse as GmbPlaceActionDeleteResponse,
    type GmbPlaceActionType as GmbPlaceActionType,
    type GmbPlaceActionCreateParams as GmbPlaceActionCreateParams,
    type GmbPlaceActionDeleteParams as GmbPlaceActionDeleteParams,
  };

  export {
    TikTokCreatorInfo as TikTokCreatorInfo,
    type TikTokCreatorInfoRetrieveResponse as TikTokCreatorInfoRetrieveResponse,
  };

  export {
    YouTubePlaylists as YouTubePlaylists,
    type YouTubePlaylistRetrieveResponse as YouTubePlaylistRetrieveResponse,
    type YouTubePlaylistSetDefaultResponse as YouTubePlaylistSetDefaultResponse,
    type YouTubePlaylistSetDefaultParams as YouTubePlaylistSetDefaultParams,
  };
}

export interface NewsletterListsResponse {
  data: Array<{
    id: string;
    name: string;
    subscriber_count: number | null;
  }>;
}

export interface NewsletterTemplatesResponse {
  data: Array<{
    id: string;
    name: string;
    preview_url: string | null;
  }>;
}
