import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';
import * as AdvancedAPI from './ads-advanced';
import { AdsAdvanced } from './ads-advanced';

/**
 * Paid ad mutations settle deterministic preflight rejections as zero usage.
 * A different idempotency key blocked by an active mutation also consumes zero
 * usage; a same-key retry remains attached to the original operation.
 */
export class Ads extends APIResource {
  advanced: AdvancedAPI.AdsAdvanced = new AdvancedAPI.AdsAdvanced(this._client);

  /** Static implementation truth, required scopes, and provider approval gates. */
  listPlatforms(options?: RequestOptions): APIPromise<AdPlatformListResponse> {
    return this._client.get('/v1/ads/platforms', options);
  }

  /** List dedicated advertising connections without credential material. */
  listConnections(
    query: AdListConnectionsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdConnectionListResponse> {
    return this._client.get('/v1/ads/connections', { query, ...options });
  }

  /**
   * Validate a provider credential with read-only account discovery, then
   * encrypt it and project the accessible ad accounts atomically.
   */
  createConnection(
    body: AdCreateConnectionParams,
    options?: RequestOptions,
  ): APIPromise<AdConnectionMutationResponse> {
    return this._client.post('/v1/ads/connections', { body, ...options });
  }

  /** Rotate a complete credential set after the same provider validation. */
  rotateConnectionCredentials(
    id: string,
    body: AdRotateConnectionCredentialsParams,
    options?: RequestOptions,
  ): APIPromise<AdConnectionMutationResponse> {
    return this._client.put(path`/v1/ads/connections/${id}/credentials`, {
      body,
      ...options,
    });
  }

  /** Idempotently revoke a connection and shred its encrypted secrets. */
  revokeConnection(id: string, options?: RequestOptions): APIPromise<AdConnectionResponse> {
    return this._client.delete(path`/v1/ads/connections/${id}`, options);
  }

  // --- Ad Accounts ---

  discoverAccounts(
    body: AdDiscoverAccountsParams,
    options?: RequestOptions,
  ): APIPromise<AdDiscoverAccountsResponse> {
    return this._client.post('/v1/ads/accounts/discover', { body, ...options });
  }

  listAccounts(
    query: AdListAccountsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdAccountListResponse> {
    return this._client.get('/v1/ads/accounts', { query, ...options });
  }

  /**
   * Trigger a manual sync for an ad account.
   *
   * Asynchronous: the full external sync (Graph fetch + ad/campaign upserts +
   * metrics refresh) is durably accepted by the ads queue before this resolves
   * with `202 { status: "queued" }`. Poll {@link listCampaigns}/{@link list}/
   * {@link getAnalytics} for results. Throws `404 NOT_FOUND` if the ad account
   * does not belong to the caller's org.
   */
  syncAccount(id: string, options?: RequestOptions): APIPromise<AdSyncQueuedResponse> {
    return this._client.post(path`/v1/ads/accounts/${id}/sync`, options);
  }

  // --- Campaigns ---

  /** Create a paid campaign using a caller-supplied, retry-stable idempotency key. */
  createCampaign(
    body: AdCreateCampaignParams,
    options: RequestOptions & { idempotencyKey: string },
  ): APIPromise<AdCampaignResponse> {
    return this._client.post('/v1/ads/campaigns', {
      body,
      ...options,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieveCampaign(id: string, options?: RequestOptions): APIPromise<AdCampaignResponse> {
    return this._client.get(path`/v1/ads/campaigns/${id}`, options);
  }

  updateCampaign(
    id: string,
    body: AdUpdateCampaignParams | null | undefined,
    options: RequestOptions & { idempotencyKey: string },
  ): APIPromise<AdUpdateCampaignResponse> {
    return this._client.patch(path`/v1/ads/campaigns/${id}`, {
      body,
      ...options,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * List campaigns. Paginated with an opaque cursor (`next_cursor`); pass it
   * back verbatim as `cursor`. Ordering is `desc(created_at), desc(id)`.
   */
  listCampaigns(
    query: AdListCampaignsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdCampaignListResponse> {
    return this._client.get('/v1/ads/campaigns', { query, ...options });
  }

  deleteCampaign(
    id: string,
    options: RequestOptions & { idempotencyKey: string },
  ): APIPromise<void> {
    return this._client.delete(path`/v1/ads/campaigns/${id}`, {
      ...options,
      idempotencyKey: options.idempotencyKey,
      headers: buildHeaders([{ Accept: '*/*' }, options.headers]),
    });
  }

  // --- Ads ---

  /** Create a paid ad using a caller-supplied, retry-stable idempotency key. */
  create(
    body: AdCreateParams,
    options: RequestOptions & { idempotencyKey: string },
  ): APIPromise<AdResponse> {
    return this._client.post('/v1/ads', {
      body,
      ...options,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Boost a post using a caller-supplied, retry-stable idempotency key. */
  boost(
    body: AdBoostParams,
    options: RequestOptions & { idempotencyKey: string },
  ): APIPromise<AdResponse> {
    return this._client.post('/v1/ads/boost', {
      body,
      ...options,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string, options?: RequestOptions): APIPromise<AdResponse> {
    return this._client.get(path`/v1/ads/${id}`, options);
  }

  update(
    id: string,
    body: AdUpdateParams | null | undefined,
    options: RequestOptions & { idempotencyKey: string },
  ): APIPromise<AdResponse> {
    return this._client.patch(path`/v1/ads/${id}`, {
      body,
      ...options,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * List ads. Paginated with an opaque cursor (`next_cursor`); pass it back
   * verbatim as `cursor`. Ordering is `desc(created_at), desc(id)`.
   */
  list(
    query: AdListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdListResponse> {
    return this._client.get('/v1/ads', { query, ...options });
  }

  delete(id: string, options: RequestOptions & { idempotencyKey: string }): APIPromise<void> {
    return this._client.delete(path`/v1/ads/${id}`, {
      ...options,
      idempotencyKey: options.idempotencyKey,
      headers: buildHeaders([{ Accept: '*/*' }, options.headers]),
    });
  }

  // --- Analytics ---

  getAnalytics(
    id: string,
    query: AdGetAnalyticsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdAnalyticsResponse> {
    return this._client.get(path`/v1/ads/${id}/analytics`, { query, ...options });
  }

  // --- Interests ---

  /** Search interests through an active ad account. Disabled accounts are not provider-authorized. */
  searchInterests(
    query: AdSearchInterestsParams,
    options?: RequestOptions,
  ): APIPromise<AdInterestListResponse> {
    return this._client.get('/v1/ads/interests', { query, ...options });
  }

  // --- Audiences ---

  /** Create an audience through an active ad account. Disabled accounts are not provider-authorized. */
  createAudience(body: AdCreateAudienceParams, options?: RequestOptions): APIPromise<AdAudienceResponse> {
    return this._client.post('/v1/ads/audiences', { body, ...options });
  }

  retrieveAudience(id: string, options?: RequestOptions): APIPromise<AdAudienceResponse> {
    return this._client.get(path`/v1/ads/audiences/${id}`, options);
  }

  /**
   * List audiences. Paginated with an opaque cursor (`next_cursor`); pass it
   * back verbatim as `cursor`. Ordering is `desc(created_at), desc(id)`.
   * Platform audience discovery runs in the background, so freshly-imported
   * audiences may appear on a subsequent request rather than the first.
   */
  listAudiences(
    query: AdListAudiencesParams,
    options?: RequestOptions,
  ): APIPromise<AdAudienceListResponse> {
    return this._client.get('/v1/ads/audiences', { query, ...options });
  }

  deleteAudience(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/ads/audiences/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  addAudienceUsers(
    id: string,
    body: AdAddAudienceUsersParams,
    options?: RequestOptions,
  ): APIPromise<AdAddAudienceUsersResponse> {
    return this._client.post(path`/v1/ads/audiences/${id}/users`, { body, ...options });
  }
}

// ---------------------------------------------------------------------------
// Response Types
// ---------------------------------------------------------------------------

export interface AdAccountResponse {
  id: string;
  ad_connection_id: string | null;
  social_account_id: string | null;
  platform: string;
  platform_ad_account_id: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  status: string | null;
  capabilities: Record<string, AdCapability>;

  /** Connected social account IDs whose published posts this ad account can boost. */
  boostable_social_account_ids: string[];

  /** Connected Pages/IG accounts this ad account can promote. */
  boostable_accounts: Array<{ id: string; platform: string; username: string | null }>;
}

export type AdCapabilityState = 'supported' | 'requires_approval' | 'unsupported';

export interface AdCapability {
  state: AdCapabilityState;
  reason?: string;
}

export interface AdPlatformCapabilities {
  platform: 'meta' | 'google' | 'tiktok' | 'linkedin' | 'pinterest' | 'twitter';
  api_version: string;
  auth_protocol: 'oauth2' | 'oauth1';
  requires_dedicated_connection: true;
  required_scopes: string[];
  operations: Record<string, AdCapability>;
  objectives: string[];
  formats: string[];
  official_docs: string[];
}

export interface AdPlatformListResponse {
  data: AdPlatformCapabilities[];
}

export interface AdConnectionResponse {
  id: string;
  workspace_id: string | null;
  platform: AdPlatformCapabilities['platform'];
  provider_principal_id: string;
  display_name: string | null;
  status: 'pending' | 'active' | 'expired' | 'revoked' | 'error';
  credential_version: number;
  scopes: string[];
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdConnectionMutationResponse {
  connection: AdConnectionResponse;
  validated_ad_accounts: number;
}

export interface AdConnectionListResponse {
  data: AdConnectionResponse[];
}

export interface AdDiscoverAccountsResponse {
  discovered: number;
}

export interface AdAccountListResponse {
  data: AdAccountResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface AdCampaignResponse {
  id: string;
  ad_account_id: string;
  platform: string;
  platform_campaign_id: string | null;
  name: string;
  objective: string;
  status: string;
  daily_budget_cents: number | null;
  lifetime_budget_cents: number | null;
  currency: string | null;
  start_date: string | null;
  end_date: string | null;
  is_external: boolean;
  ad_count?: number;
  metrics?: Record<string, number> | null;
  created_at: string;
  updated_at: string;
}

export interface AdCampaignListResponse {
  data: AdCampaignResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface AdResponse {
  id: string;
  campaign_id: string;
  ad_account_id: string;
  platform: string;
  platform_ad_id: string | null;
  name: string;
  status: string;
  headline: string | null;
  body: string | null;
  call_to_action: string | null;
  link_url: string | null;
  image_url: string | null;
  video_url: string | null;
  boost_post_target_id: string | null;
  boost_external_post_id: string | null;
  targeting: Record<string, unknown> | null;
  daily_budget_cents: number | null;
  lifetime_budget_cents: number | null;
  start_date: string | null;
  end_date: string | null;
  duration_days: number | null;
  is_external: boolean;
  created_at: string;
  updated_at: string;
}

export interface AdListResponse {
  data: AdResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface AdAnalyticsResponse {
  summary: {
    impressions: number;
    reach: number;
    clicks: number;
    spend_cents: number;
    conversions: number;
    ctr: number;
    cpc_cents: number;
    cpm_cents: number;
  };
  daily: Array<{
    date: string;
    impressions: number;
    reach: number;
    clicks: number;
    spend_cents: number;
    conversions: number;
    video_views: number;
    engagement: number;
    ctr?: number;
    cpc_cents?: number;
    cpm_cents?: number;
  }>;
  demographics?: {
    age_gender?: Array<{ age_range: string; gender: string; percentage: number }>;
    locations?: Array<{ country: string; percentage: number }>;
  };
}

export interface AdInterestResponse {
  id: string;
  name: string;
  category?: string;
  audience_size?: number;
}

export interface AdInterestListResponse {
  data: AdInterestResponse[];
}

export interface AdAudienceResponse {
  id: string;
  ad_account_id: string;
  platform: string;
  platform_audience_id: string | null;
  name: string;
  type: string;
  description: string | null;
  size: number | null;
  status: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdAudienceListResponse {
  data: AdAudienceResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface AdAddAudienceUsersResponse {
  added: number;
  invalid: number;
  stored: number;
}

export interface AdUpdateCampaignResponse {
  updated: number;
  skipped: number;
}

/**
 * 202 acknowledgement from {@link Ads.syncAccount}. The sync runs asynchronously
 * on the ads queue; poll the list/analytics endpoints for completion.
 */
export interface AdSyncQueuedResponse {
  status: 'queued';
}

// ---------------------------------------------------------------------------
// Params Types
// ---------------------------------------------------------------------------

export interface AdListAccountsParams {
  cursor?: string;
  limit?: number;
  q?: string;
  social_account_id?: string;
  workspace_id?: string;
}

export interface AdListConnectionsParams {
  platform?: AdPlatformCapabilities['platform'];
  workspace_id?: string;
  status?: AdConnectionResponse['status'];
}

export interface AdDiscoverAccountsParams {
  ad_connection_id: string;
}

export interface AdConnectionCredentialMetadata {
  /** Google Ads manager customer ID, with or without hyphens. */
  login_customer_id?: string;
  /** TikTok advertiser IDs returned by the Business OAuth exchange. */
  advertiser_ids?: string[];
}

export interface AdConnectionCredentialParams {
  /** Write-only; encrypted and never returned. */
  access_token: string;
  /** Write-only; stored for explicit/future refresh support and never returned. */
  refresh_token?: string;
  /** Write-only OAuth 1.0a token secret, required for X Ads. */
  token_secret?: string;
  access_token_expires_at?: string;
  refresh_token_expires_at?: string;
  scopes?: string[];
  metadata?: AdConnectionCredentialMetadata;
}

export interface AdCreateConnectionParams extends AdConnectionCredentialParams {
  platform: AdPlatformCapabilities['platform'];
  workspace_id?: string;
  provider_principal_id: string;
  display_name?: string;
}

export type AdRotateConnectionCredentialsParams = AdConnectionCredentialParams;

export interface AdGoogleKeyword {
  text: string;
  match_type: 'BROAD' | 'PHRASE' | 'EXACT';
}

export interface AdGoogleCampaignProviderSettings {
  contains_eu_political_advertising:
    | 'CONTAINS_EU_POLITICAL_ADVERTISING'
    | 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING';
  bidding_strategy?: 'MANUAL_CPC' | 'MAXIMIZE_CLICKS' | 'MAXIMIZE_CONVERSIONS';
  keywords: AdGoogleKeyword[];
  default_cpc_bid_cents?: number;
  network_settings?: {
    target_google_search?: boolean;
    target_search_network?: boolean;
    target_content_network?: boolean;
    target_partner_search_network?: boolean;
  };
  geo_target_constant_ids?: string[];
  language_constant_ids?: string[];
}

export interface AdLinkedinCampaignProviderSettings {
  locale: { country: string; language: string };
  include: Array<{ facet_urn: string; values: string[] }>;
  exclude?: Array<{ facet_urn: string; values: string[] }>;
  associated_entity: string;
  political_intent: 'POLITICAL' | 'NOT_POLITICAL' | 'NOT_DECLARED';
  format?: 'SINGLE_IMAGE' | 'SINGLE_VIDEO' | 'CAROUSEL' | 'DOCUMENT';
  cost_type?: 'CPC' | 'CPM' | 'CPV';
  unit_cost_cents: number;
  audience_expansion_enabled?: boolean;
  offsite_delivery_enabled?: boolean;
}

export interface AdPinterestCampaignProviderSettings {
  bid_in_micro_currency: number;
  billable_event: 'CLICKTHROUGH' | 'IMPRESSION' | 'VIDEO_V_50_MRC';
  bid_strategy_type?: 'AUTOMATIC_BID' | 'MAX_BID' | 'TARGET_AVG';
  placement_group?: 'ALL' | 'SEARCH' | 'BROWSE' | 'OTHER';
  auto_targeting_enabled?: boolean;
  geo_codes?: string[];
  locale_codes?: string[];
}

export interface AdTikTokCampaignProviderSettings {
  location_ids: string[];
  optimization_goal:
    | 'CLICK'
    | 'PAGE_VISIT'
    | 'REACH'
    | 'ENGAGED_VIEW'
    | 'ENGAGED_VIEW_FIFTEEN';
  billing_event: 'CPC' | 'CPM' | 'CPV';
  promotion_type?: 'WEBSITE';
  placement_type?: 'PLACEMENT_TYPE_NORMAL';
  placements?: ['PLACEMENT_TIKTOK'];
  budget_mode: 'BUDGET_MODE_DAY' | 'BUDGET_MODE_TOTAL';
  schedule_type: 'SCHEDULE_START_END' | 'SCHEDULE_FROM_NOW';
  /** Advertiser-timezone value formatted as YYYY-MM-DD HH:mm:ss. */
  schedule_start_time: string;
  /** Advertiser-timezone value formatted as YYYY-MM-DD HH:mm:ss. */
  schedule_end_time?: string;
  gender?: 'GENDER_UNLIMITED' | 'GENDER_MALE' | 'GENDER_FEMALE';
  age_groups?: string[];
  languages?: string[];
  interest_category_ids?: string[];
  audience_ids?: string[];
  excluded_audience_ids?: string[];
  operating_systems?: Array<'ANDROID' | 'IOS'>;
  bid_type?: 'BID_TYPE_NO_BID' | 'BID_TYPE_CUSTOM';
  bid_price?: number;
}

export interface AdTwitterCampaignProviderSettings {
  funding_instrument_id: string;
  objective: 'REACH' | 'WEBSITE_CLICKS' | 'ENGAGEMENTS' | 'VIDEO_VIEWS';
  placements?: 'ALL_ON_TWITTER' | 'TWITTER_TIMELINE';
  bid_strategy?: 'AUTO' | 'MAX' | 'TARGET';
  bid_amount_local_micro?: number;
  /** Explicit consent to X's documented no-targeting worldwide delivery. */
  allow_worldwide_targeting: true;
}

export type AdCampaignProviderOptions =
  | { platform: 'google'; settings: AdGoogleCampaignProviderSettings }
  | { platform: 'linkedin'; settings: AdLinkedinCampaignProviderSettings }
  | { platform: 'pinterest'; settings: AdPinterestCampaignProviderSettings }
  | { platform: 'tiktok'; settings: AdTikTokCampaignProviderSettings }
  | { platform: 'twitter'; settings: AdTwitterCampaignProviderSettings };

export type AdCreateProviderOptions =
  | {
      platform: 'google';
      campaign?: AdGoogleCampaignProviderSettings;
      creative: {
        headlines: string[];
        descriptions: string[];
        final_urls: string[];
        path1?: string;
        path2?: string;
      };
    }
  | {
      platform: 'linkedin';
      campaign?: AdLinkedinCampaignProviderSettings;
      creative: { content_reference: string };
    }
  | {
      platform: 'pinterest';
      campaign?: AdPinterestCampaignProviderSettings;
      creative: {
        /** Required for standalone ads; boosts use the selected post's Pin ID. */
        pin_id?: string;
        creative_type: 'REGULAR' | 'VIDEO' | 'CAROUSEL' | 'COLLECTION' | 'IDEA';
        destination_url?: string;
      };
    }
  | {
      platform: 'tiktok';
      campaign?: AdTikTokCampaignProviderSettings;
      creative: {
        identity_type: 'CUSTOMIZED_USER' | 'AUTH_CODE' | 'TT_USER' | 'BC_AUTH_TT';
        identity_id: string;
        identity_authorized_bc_id?: string;
        /** Required for standalone Spark Ads; boosts use the selected post ID. */
        tiktok_item_id?: string;
        video_id?: string;
        display_name?: string;
        ad_text?: string;
        call_to_action?: string;
        landing_page_url?: string;
      };
    }
  | {
      platform: 'twitter';
      campaign?: AdTwitterCampaignProviderSettings;
      creative: {
        /** Required for standalone ads; boosts use the selected post's Tweet ID. */
        tweet_id?: string;
      };
    };

export interface AdCreateCampaignParams {
  ad_account_id: string;
  name: string;
  objective: string;
  daily_budget_cents?: number;
  lifetime_budget_cents?: number;
  currency?: string;
  start_date?: string;
  end_date?: string;
  special_ad_categories?: string[];
  /** Typed provider-specific settings; platform must match ad_account_id. */
  provider_options?: AdCampaignProviderOptions;
}

export interface AdUpdateCampaignParams {
  name?: string;
  status?: 'active' | 'paused';
  daily_budget_cents?: number;
  lifetime_budget_cents?: number;
}

export interface AdListCampaignsParams {
  platform?: string;
  status?: string;
  ad_account_id?: string;
  workspace_id?: string;
  cursor?: string;
  limit?: number;
}

export interface AdCreateParams {
  ad_account_id: string;
  /** Reuse a campaign's shared ad set. Objective, targeting, budgets, duration, and schedule overrides are rejected when supplied. */
  campaign_id?: string;
  name: string;
  objective?: string;
  headline?: string;
  body?: string;
  call_to_action?: string;
  link_url?: string;
  image_url?: string;
  video_url?: string;
  /** Meta targeting. City values are targeting-search location keys, languages are numeric ad-locale IDs encoded as strings, and normalized fields override platform_specific conflicts. */
  targeting?: Record<string, unknown>;
  daily_budget_cents?: number;
  lifetime_budget_cents?: number;
  duration_days?: number;
  start_date?: string;
  end_date?: string;
  /** Typed provider-specific settings; platform must match ad_account_id. */
  provider_options?: AdCreateProviderOptions;
}

export interface AdBoostParams {
  ad_account_id: string;
  /** Published RelayAPI post target ID (pt_) to boost. Provide exactly one of post_target_id or external_post_id. */
  post_target_id?: string;
  /** Natively-published / external post ID (xp_) to boost. Provide exactly one of post_target_id or external_post_id. */
  external_post_id?: string;
  name?: string;
  objective?: string;
  /** Meta targeting. City values are targeting-search location keys, languages are numeric ad-locale IDs encoded as strings, and normalized fields override platform_specific conflicts. */
  targeting?: Record<string, unknown>;
  daily_budget_cents: number;
  lifetime_budget_cents?: number;
  currency?: string;
  duration_days: number;
  start_date?: string;
  end_date?: string;
  bid_amount?: number;
  tracking?: { pixel_id?: string; url_tags?: string };
  special_ad_categories?: string[];
  /** Required campaign/identity settings for non-Meta boost providers. */
  provider_options?: AdCreateProviderOptions;
}

export interface AdUpdateParams {
  name?: string;
  status?: 'active' | 'paused';
  daily_budget_cents?: number;
  lifetime_budget_cents?: number;
  /** Meta targeting. City values are targeting-search location keys, languages are numeric ad-locale IDs encoded as strings, and normalized fields override platform_specific conflicts. */
  targeting?: Record<string, unknown>;
}

export interface AdListParams {
  campaign_id?: string;
  platform?: string;
  status?: string;
  workspace_id?: string;
  source?: 'all' | 'internal' | 'external';
  cursor?: string;
  limit?: number;
}

export interface AdGetAnalyticsParams {
  from?: string;
  to?: string;
  breakdowns?: string;
}

export interface AdSearchInterestsParams {
  q: string;
  /** Preferred selector for dedicated ad connections. */
  ad_account_id?: string;
  /** Deprecated Meta-only compatibility selector. */
  social_account_id?: string;
}

export interface AdCreateAudienceParams {
  ad_account_id: string;
  name: string;
  type: 'customer_list' | 'website' | 'lookalike';
  description?: string;
  pixel_id?: string;
  retention_days?: number;
  rule?: Record<string, unknown>;
  source_audience_id?: string;
  country?: string;
  ratio?: number;
  customer_file_source?: string;
}

export interface AdListAudiencesParams {
  ad_account_id: string;
  cursor?: string;
  limit?: number;
}

export interface AdAddAudienceUsersParams {
  users: Array<{ email?: string; phone?: string }>;
}

Ads.Advanced = AdsAdvanced;

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------

export declare namespace Ads {
  export { AdsAdvanced as Advanced };

  export {
    type AdCapabilityState as AdCapabilityState,
    type AdCapability as AdCapability,
    type AdPlatformCapabilities as AdPlatformCapabilities,
    type AdPlatformListResponse as AdPlatformListResponse,
    type AdConnectionResponse as AdConnectionResponse,
    type AdConnectionListResponse as AdConnectionListResponse,
    type AdConnectionMutationResponse as AdConnectionMutationResponse,
    type AdDiscoverAccountsResponse as AdDiscoverAccountsResponse,
    type AdAccountResponse as AdAccountResponse,
    type AdAccountListResponse as AdAccountListResponse,
    type AdCampaignResponse as AdCampaignResponse,
    type AdCampaignListResponse as AdCampaignListResponse,
    type AdResponse as AdResponse,
    type AdListResponse as AdListResponse,
    type AdAnalyticsResponse as AdAnalyticsResponse,
    type AdInterestResponse as AdInterestResponse,
    type AdInterestListResponse as AdInterestListResponse,
    type AdAudienceResponse as AdAudienceResponse,
    type AdAudienceListResponse as AdAudienceListResponse,
    type AdAddAudienceUsersResponse as AdAddAudienceUsersResponse,
    type AdUpdateCampaignResponse as AdUpdateCampaignResponse,
    type AdSyncQueuedResponse as AdSyncQueuedResponse,
    type AdListAccountsParams as AdListAccountsParams,
    type AdListConnectionsParams as AdListConnectionsParams,
    type AdDiscoverAccountsParams as AdDiscoverAccountsParams,
    type AdConnectionCredentialMetadata as AdConnectionCredentialMetadata,
    type AdConnectionCredentialParams as AdConnectionCredentialParams,
    type AdCreateConnectionParams as AdCreateConnectionParams,
    type AdRotateConnectionCredentialsParams as AdRotateConnectionCredentialsParams,
    type AdGoogleKeyword as AdGoogleKeyword,
    type AdGoogleCampaignProviderSettings as AdGoogleCampaignProviderSettings,
    type AdLinkedinCampaignProviderSettings as AdLinkedinCampaignProviderSettings,
    type AdCampaignProviderOptions as AdCampaignProviderOptions,
    type AdCreateProviderOptions as AdCreateProviderOptions,
    type AdCreateCampaignParams as AdCreateCampaignParams,
    type AdUpdateCampaignParams as AdUpdateCampaignParams,
    type AdListCampaignsParams as AdListCampaignsParams,
    type AdCreateParams as AdCreateParams,
    type AdBoostParams as AdBoostParams,
    type AdUpdateParams as AdUpdateParams,
    type AdListParams as AdListParams,
    type AdGetAnalyticsParams as AdGetAnalyticsParams,
    type AdSearchInterestsParams as AdSearchInterestsParams,
    type AdCreateAudienceParams as AdCreateAudienceParams,
    type AdListAudiencesParams as AdListAudiencesParams,
    type AdAddAudienceUsersParams as AdAddAudienceUsersParams,
  };
}
