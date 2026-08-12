import { APIPromise } from '../core/api-promise';
import { APIResource } from '../core/resource';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export type AdPlatform = 'meta' | 'google' | 'tiktok' | 'linkedin' | 'pinterest' | 'twitter';
export type AdvancedAdFeature =
  | 'lead_forms'
  | 'lead_inbox'
  | 'lead_promotion'
  | 'conversions'
  | 'messaging_experiences'
  | 'report_jobs'
  | 'forecasts'
  | 'keyword_ideas'
  | 'creative_assets'
  | 'catalogs'
  | 'product_sets';

export interface AdvancedAdCapability {
  state: 'supported' | 'requires_approval' | 'unsupported';
  reason?: string;
  required_scopes: string[];
  required_program?: string;
  checked_at: string | null;
}

export interface AdvancedAdAccountCapabilitiesResponse {
  ad_account_id: string;
  platform: AdPlatform;
  capabilities: Record<AdvancedAdFeature, AdvancedAdCapability>;
}

export interface AdAdvancedListParams {
  ad_account_id: string;
  cursor?: string;
  limit?: number;
}

export interface AdLeadForm {
  id: string;
  workspace_id: string | null;
  ad_account_id: string;
  platform: AdPlatform;
  provider_form_id: string;
  name: string | null;
  status: 'draft' | 'active' | 'archived' | 'unknown';
  configuration: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AdLeadFormListResponse {
  data: AdLeadForm[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface AdLinkLeadFormParams {
  ad_account_id: string;
  provider_form_id: string;
  name?: string;
  status?: 'draft' | 'active' | 'archived' | 'unknown';
  configuration?: Record<string, unknown>;
}

export interface AdLead {
  id: string;
  workspace_id: string | null;
  ad_account_id: string;
  lead_form_id: string | null;
  platform: AdPlatform;
  provider_lead_id: string;
  status: 'new' | 'promoted' | 'dismissed';
  data: Record<string, unknown>;
  contact_id: string | null;
  provider_created_at: string | null;
  expires_at: string;
  created_at: string;
}

export interface AdLeadListParams extends AdAdvancedListParams {
  status?: 'new' | 'promoted' | 'dismissed';
  lead_form_id?: string;
}

export interface AdLeadListResponse {
  data: AdLead[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface AdPromoteLeadParams {
  name_field?: string;
  email_field?: string;
  phone_field?: string;
  tags?: string[];
  metadata_fields?: string[];
}

export interface AdPromoteLeadResponse {
  lead: AdLead;
  contact_id: string;
  created: boolean;
}

export interface AdCreateConversionRuleParams {
  ad_account_id: string;
  name: string;
  event_name: string;
  provider_destination_id: string;
  configuration?: Record<string, unknown>;
  enabled?: boolean;
}

export interface AdConversionRule {
  id: string;
  workspace_id: string | null;
  ad_account_id: string;
  platform: AdPlatform;
  name: string;
  event_name: string;
  provider_destination_id: string;
  configuration: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AdCreateConversionEventParams {
  conversion_rule_id: string;
  event_id: string;
  occurred_at: string;
  value_micros?: string;
  currency?: string;
  identifiers?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

export interface AdConversionEvent {
  id: string;
  conversion_rule_id: string;
  ad_account_id: string;
  platform: AdPlatform;
  event_id: string;
  status:
    | 'pending'
    | 'processing'
    | 'request_may_have_been_sent'
    | 'unknown'
    | 'completed'
    | 'failed'
    | 'cancelled';
  provider_event_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type AdMessagingConfiguration =
  | {
      platform: 'meta';
      destination: 'messenger' | 'instagram_direct' | 'whatsapp';
      page_id: string;
      welcome_message?: string;
    }
  | { platform: 'google'; provider: string; provider_account_id: string }
  | { platform: 'tiktok'; identity_id: string; message_scenario: string }
  | { platform: 'linkedin'; conversation_ad_id: string }
  | { platform: 'twitter'; conversation_card_id: string };

export interface AdLinkMessagingExperienceParams {
  ad_account_id: string;
  name: string;
  provider_resource_id: string;
  configuration: AdMessagingConfiguration;
}

export interface AdLinkCreativeAssetParams {
  ad_account_id: string;
  name?: string;
  media_id?: string;
  provider_resource_id?: string;
  asset_type: 'image' | 'video' | 'text' | 'document' | 'other';
  configuration?: Record<string, unknown>;
}

export interface AdLinkCatalogParams {
  ad_account_id: string;
  name: string;
  provider_resource_id: string;
  configuration?: Record<string, unknown>;
}

export interface AdLinkProductSetParams {
  ad_account_id: string;
  name: string;
  provider_resource_id?: string;
  filter: Record<string, unknown>;
}

export interface AdAdvancedResource {
  id: string;
  workspace_id: string | null;
  ad_account_id: string;
  platform: AdPlatform;
  kind: 'messaging_experience' | 'creative_asset' | 'catalog' | 'product_set';
  provider_resource_id: string | null;
  parent_id: string | null;
  name: string | null;
  status: string;
  configuration: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type AdReportProviderRequest =
  | {
      platform: 'tiktok';
      report_type?: 'BASIC' | 'AUDIENCE' | 'CATALOG';
      data_level: 'AUCTION_AD' | 'AUCTION_ADGROUP' | 'AUCTION_CAMPAIGN' | 'AUCTION_ADVERTISER';
      dimensions: string[];
      metrics: string[];
      start_date: string;
      end_date: string;
      filters?: Record<string, unknown>[];
      output_format?: 'CSV_DOWNLOAD';
    }
  | {
      platform: 'twitter';
      entity:
        | 'ACCOUNT'
        | 'CAMPAIGN'
        | 'FUNDING_INSTRUMENT'
        | 'LINE_ITEM'
        | 'PROMOTED_ACCOUNT'
        | 'PROMOTED_TWEET';
      entity_ids: string[];
      start_time: string;
      end_time: string;
      granularity: 'DAY' | 'HOUR' | 'TOTAL';
      placement: 'ALL_ON_TWITTER' | 'SPOTLIGHT' | 'TREND';
      metric_groups: Array<
        | 'BILLING'
        | 'ENGAGEMENT'
        | 'LIFE_TIME_VALUE_MOBILE_CONVERSION'
        | 'MOBILE_CONVERSION'
        | 'VIDEO'
        | 'WEB_CONVERSION'
      >;
      segmentation_type?: string;
    }
  | {
      platform: 'linkedin';
      pivot:
        | 'COMPANY'
        | 'ACCOUNT'
        | 'SHARE'
        | 'CAMPAIGN'
        | 'CREATIVE'
        | 'CAMPAIGN_GROUP'
        | 'CONVERSION'
        | 'CONVERSATION_NODE'
        | 'CONVERSATION_NODE_OPTION_INDEX'
        | 'SERVING_LOCATION'
        | 'EVENT_STAGE'
        | 'MEMBER_COMPANY'
        | 'MEMBER_INDUSTRY'
        | 'MEMBER_SENIORITY'
        | 'MEMBER_JOB_TITLE'
        | 'MEMBER_JOB_FUNCTION'
        | 'MEMBER_COUNTRY_V2'
        | 'MEMBER_REGION'
        | 'MEMBER_COUNTY'
        | 'MEMBER_SKILLS'
        | 'MEMBER_DEGREE'
        | 'MEMBER_FIELD_OF_STUDY';
      start_date: string;
      end_date: string;
      time_granularity: 'ALL' | 'DAILY' | 'MONTHLY' | 'YEARLY';
      fields: string[];
    };

export interface AdCreateReportParams {
  ad_account_id: string;
  request: AdReportProviderRequest;
}

export interface AdReportJob {
  id: string;
  workspace_id: string | null;
  ad_account_id: string;
  platform: AdPlatform;
  status:
    | 'pending'
    | 'submitting'
    | 'provider_pending'
    | 'downloading'
    | 'completed'
    | 'failed'
    | 'unknown'
    | 'cancelled';
  request: AdReportProviderRequest;
  provider_job_id: string | null;
  row_count: number | null;
  result_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AdReportResultRow {
  dimensions: Record<string, unknown>;
  metrics: Record<string, string | number | null>;
}

export interface AdReportResultsParams {
  cursor?: string;
  limit?: number;
}

export interface AdReportResultsResponse {
  data: AdReportResultRow[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface AdPlanningParams {
  ad_account_id: string;
  seed_keywords: string[];
  language?: string;
  geo_targets?: string[];
  provider_options?: Record<string, unknown>;
}

export interface AdPlanningResponse {
  platform: AdPlatform;
  kind: 'forecast' | 'keyword_ideas';
  data: Record<string, unknown>[];
}

/** Advanced ads surface. Provider-gated methods fail before provider I/O. */
export class AdsAdvanced extends APIResource {
  getAccountCapabilities(
    adAccountID: string,
    options?: RequestOptions,
  ): APIPromise<AdvancedAdAccountCapabilitiesResponse> {
    return this._client.get(path`/v1/ads/accounts/${adAccountID}/advanced-capabilities`, options);
  }

  listLeadForms(
    query: AdAdvancedListParams,
    options?: RequestOptions,
  ): APIPromise<AdLeadFormListResponse> {
    return this._client.get('/v1/ads/lead-forms', { query, ...options });
  }

  linkLeadForm(body: AdLinkLeadFormParams, options?: RequestOptions): APIPromise<AdLeadForm> {
    return this._client.post('/v1/ads/lead-forms', { body, ...options });
  }

  listLeads(query: AdLeadListParams, options?: RequestOptions): APIPromise<AdLeadListResponse> {
    return this._client.get('/v1/ads/leads', { query, ...options });
  }

  retrieveLead(id: string, options?: RequestOptions): APIPromise<AdLead> {
    return this._client.get(path`/v1/ads/leads/${id}`, options);
  }

  promoteLead(
    id: string,
    body: AdPromoteLeadParams = {},
    options?: RequestOptions,
  ): APIPromise<AdPromoteLeadResponse> {
    return this._client.post(path`/v1/ads/leads/${id}/promote`, { body, ...options });
  }

  createConversionRule(
    body: AdCreateConversionRuleParams,
    options?: RequestOptions,
  ): APIPromise<AdConversionRule> {
    return this._client.post('/v1/ads/conversion-rules', { body, ...options });
  }

  createConversionEvent(
    body: AdCreateConversionEventParams,
    options?: RequestOptions,
  ): APIPromise<AdConversionEvent> {
    return this._client.post('/v1/ads/conversion-events', { body, ...options });
  }

  linkMessagingExperience(
    body: AdLinkMessagingExperienceParams,
    options?: RequestOptions,
  ): APIPromise<AdAdvancedResource> {
    return this._client.post('/v1/ads/messaging-experiences', { body, ...options });
  }

  linkCreativeAsset(
    body: AdLinkCreativeAssetParams,
    options?: RequestOptions,
  ): APIPromise<AdAdvancedResource> {
    return this._client.post('/v1/ads/assets', { body, ...options });
  }

  linkCatalog(body: AdLinkCatalogParams, options?: RequestOptions): APIPromise<AdAdvancedResource> {
    return this._client.post('/v1/ads/catalogs', { body, ...options });
  }

  linkProductSet(
    catalogID: string,
    body: AdLinkProductSetParams,
    options?: RequestOptions,
  ): APIPromise<AdAdvancedResource> {
    return this._client.post(path`/v1/ads/catalogs/${catalogID}/product-sets`, {
      body,
      ...options,
    });
  }

  createReport(
    body: AdCreateReportParams,
    options: RequestOptions & { idempotencyKey: string },
  ): APIPromise<AdReportJob> {
    return this._client.post('/v1/ads/reports', {
      body,
      ...options,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieveReport(id: string, options?: RequestOptions): APIPromise<AdReportJob> {
    return this._client.get(path`/v1/ads/reports/${id}`, options);
  }

  listReportResults(
    id: string,
    query: AdReportResultsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdReportResultsResponse> {
    return this._client.get(path`/v1/ads/reports/${id}/results`, { query, ...options });
  }

  forecast(body: AdPlanningParams, options?: RequestOptions): APIPromise<AdPlanningResponse> {
    return this._client.post('/v1/ads/planning/forecast', { body, ...options });
  }

  keywordIdeas(body: AdPlanningParams, options?: RequestOptions): APIPromise<AdPlanningResponse> {
    return this._client.post('/v1/ads/planning/keyword-ideas', { body, ...options });
  }
}
