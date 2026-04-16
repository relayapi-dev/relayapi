import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class Ads extends APIResource {
  // --- Ad Accounts ---

  listAccounts(
    query: AdListAccountsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdAccountListResponse> {
    return this._client.get('/v1/ads/accounts', { query, ...options });
  }

  syncAccount(id: string, options?: RequestOptions): APIPromise<AdSyncResponse> {
    return this._client.post(path`/v1/ads/accounts/${id}/sync`, options);
  }

  // --- Campaigns ---

  createCampaign(body: AdCreateCampaignParams, options?: RequestOptions): APIPromise<AdCampaignResponse> {
    return this._client.post('/v1/ads/campaigns', { body, ...options });
  }

  retrieveCampaign(id: string, options?: RequestOptions): APIPromise<AdCampaignResponse> {
    return this._client.get(path`/v1/ads/campaigns/${id}`, options);
  }

  updateCampaign(
    id: string,
    body: AdUpdateCampaignParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdUpdateCampaignResponse> {
    return this._client.patch(path`/v1/ads/campaigns/${id}`, { body, ...options });
  }

  listCampaigns(
    query: AdListCampaignsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdCampaignListResponse> {
    return this._client.get('/v1/ads/campaigns', { query, ...options });
  }

  deleteCampaign(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/ads/campaigns/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  // --- Ads ---

  create(body: AdCreateParams, options?: RequestOptions): APIPromise<AdResponse> {
    return this._client.post('/v1/ads', { body, ...options });
  }

  boost(body: AdBoostParams, options?: RequestOptions): APIPromise<AdResponse> {
    return this._client.post('/v1/ads/boost', { body, ...options });
  }

  retrieve(id: string, options?: RequestOptions): APIPromise<AdResponse> {
    return this._client.get(path`/v1/ads/${id}`, options);
  }

  update(
    id: string,
    body: AdUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdResponse> {
    return this._client.patch(path`/v1/ads/${id}`, { body, ...options });
  }

  list(
    query: AdListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdListResponse> {
    return this._client.get('/v1/ads', { query, ...options });
  }

  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/ads/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
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

  searchInterests(
    query: AdSearchInterestsParams,
    options?: RequestOptions,
  ): APIPromise<AdInterestListResponse> {
    return this._client.get('/v1/ads/interests', { query, ...options });
  }

  // --- Audiences ---

  createAudience(body: AdCreateAudienceParams, options?: RequestOptions): APIPromise<AdAudienceResponse> {
    return this._client.post('/v1/ads/audiences', { body, ...options });
  }

  retrieveAudience(id: string, options?: RequestOptions): APIPromise<AdAudienceResponse> {
    return this._client.get(path`/v1/ads/audiences/${id}`, options);
  }

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
  social_account_id: string;
  platform: string;
  platform_ad_account_id: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  status: string | null;
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

export interface AdSyncResponse {
  ads_created: number;
  ads_updated: number;
  metrics_updated: number;
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
  campaign_id?: string;
  name: string;
  objective?: string;
  headline?: string;
  body?: string;
  call_to_action?: string;
  link_url?: string;
  image_url?: string;
  video_url?: string;
  targeting?: Record<string, unknown>;
  daily_budget_cents?: number;
  lifetime_budget_cents?: number;
  duration_days?: number;
  start_date?: string;
  end_date?: string;
}

export interface AdBoostParams {
  ad_account_id: string;
  post_target_id: string;
  name?: string;
  objective?: string;
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
}

export interface AdUpdateParams {
  name?: string;
  status?: 'active' | 'paused';
  daily_budget_cents?: number;
  lifetime_budget_cents?: number;
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
  q?: string;
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
  ad_account_id?: string;
  cursor?: string;
  limit?: number;
}

export interface AdAddAudienceUsersParams {
  users: Array<{ email?: string; phone?: string }>;
}

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------

export declare namespace Ads {
  export {
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
    type AdSyncResponse as AdSyncResponse,
    type AdListAccountsParams as AdListAccountsParams,
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
