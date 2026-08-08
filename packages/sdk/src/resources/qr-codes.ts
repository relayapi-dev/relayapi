import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class QrCodes extends APIResource {
  create(body: QrCodeCreateParams, options?: RequestOptions): APIPromise<QrCodeResponse> {
    return this._client.post('/v1/qr-codes', { body, ...options });
  }

  list(
    query: QrCodeListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<QrCodeListResponse> {
    return this._client.get('/v1/qr-codes', { query, ...options });
  }

  retrieve(id: string, options?: RequestOptions): APIPromise<QrCodeResponse> {
    return this._client.get(path`/v1/qr-codes/${id}`, options);
  }

  update(
    id: string,
    body: QrCodeUpdateParams,
    options?: RequestOptions,
  ): APIPromise<QrCodeResponse> {
    return this._client.patch(path`/v1/qr-codes/${id}`, { body, ...options });
  }

  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/qr-codes/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Returns deterministic SVG bytes. Most clients can use `image_url` from the
   * resource directly because that public URL renders the same bytes on demand.
   */
  image(id: string, options?: RequestOptions): APIPromise<string> {
    return this._client.get(path`/v1/qr-codes/${id}/image`, {
      ...options,
      headers: buildHeaders([{ Accept: 'image/svg+xml' }, options?.headers]),
    });
  }
}

export interface QrCodeCreateParams {
  ref_url_id: string;
  label: string;
  campaign_key?: string | null;
}

export interface QrCodeUpdateParams {
  label?: string;
  campaign_key?: string | null;
}

export interface QrCodeListParams {
  cursor?: string;
  limit?: number;
  workspace_id?: string;
  ref_url_id?: string;
  campaign_key?: string;
}

export interface QrCodeResponse {
  id: string;
  public_id: string;
  organization_id: string;
  workspace_id: string | null;
  ref_url_id: string;
  label: string;
  campaign_key: string | null;
  scan_count: number;
  scan_url: string;
  image_url: string;
  created_at: string;
  updated_at: string;
}

export interface QrCodeListResponse {
  data: QrCodeResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

