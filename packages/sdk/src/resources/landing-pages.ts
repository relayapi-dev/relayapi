import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class LandingPages extends APIResource {
  create(body: LandingPageCreateParams, options?: RequestOptions): APIPromise<LandingPageResponse> {
    return this._client.post('/v1/landing-pages', { body, ...options });
  }

  list(
    query: LandingPageListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<LandingPageListResponse> {
    return this._client.get('/v1/landing-pages', { query, ...options });
  }

  retrieve(id: string, options?: RequestOptions): APIPromise<LandingPageResponse> {
    return this._client.get(path`/v1/landing-pages/${id}`, options);
  }

  update(
    id: string,
    body: LandingPageUpdateParams,
    options?: RequestOptions,
  ): APIPromise<LandingPageResponse> {
    return this._client.patch(path`/v1/landing-pages/${id}`, { body, ...options });
  }

  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/landing-pages/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface LandingPageTheme {
  mode: 'light' | 'dark';
  background_color: string;
  text_color: string;
  accent_color: string;
  font: 'sans' | 'serif';
}

export interface LandingPageFormField {
  key: 'name' | 'email' | 'phone';
  label: string;
  required: boolean;
  placeholder?: string;
}

export type LandingPageBlock =
  | { id: string; type: 'heading'; level: 1 | 2 | 3; text: string }
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'image'; url: string; alt: string }
  | {
      id: string;
      type: 'form';
      fields: LandingPageFormField[];
      submit_label: string;
      success_message: string;
    }
  | { id: string; type: 'cta'; label: string; url: string };

export interface LandingPageConfig {
  version: 1;
  theme: LandingPageTheme;
  blocks: LandingPageBlock[];
}

export interface LandingPageCreateParams {
  workspace_id?: string;
  slug: string;
  title: string;
  config: LandingPageConfig;
  automation_id?: string | null;
  enabled?: boolean;
}

export interface LandingPageUpdateParams {
  slug?: string;
  title?: string;
  config?: LandingPageConfig;
  automation_id?: string | null;
  enabled?: boolean;
}

export interface LandingPageListParams {
  cursor?: string;
  limit?: number;
  workspace_id?: string;
  automation_id?: string;
}

export interface LandingPageResponse {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  slug: string;
  title: string;
  config: LandingPageConfig;
  automation_id: string | null;
  visits: number;
  conversions: number;
  enabled: boolean;
  public_url: string;
  conversion_url: string;
  created_at: string;
  updated_at: string;
}

export interface LandingPageListResponse {
  data: LandingPageResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

