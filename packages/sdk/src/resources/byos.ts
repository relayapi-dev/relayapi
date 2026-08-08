// Hand-written scaffold matching /v1/byos routes. Superseded by Stainless
// regeneration on the next OpenAPI pass.

import { APIPromise } from '../core/api-promise';
import { APIResource } from '../core/resource';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';

export class Byos extends APIResource {
  retrieve(options?: RequestOptions): APIPromise<ByosConfigResponse> {
    return this._client.get('/v1/byos', options);
  }

  update(body: ByosConfigParams, options?: RequestOptions): APIPromise<ByosConfigResponse> {
    return this._client.put('/v1/byos', { body, ...options });
  }

  test(options?: RequestOptions): APIPromise<ByosConfigResponse> {
    return this._client.post('/v1/byos/test', options);
  }

  delete(options?: RequestOptions): APIPromise<void> {
    return this._client.delete('/v1/byos', {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface ByosConfigParams {
  endpoint: string;
  bucket: string;
  region?: string;
  key_prefix?: string;
  force_path_style?: boolean;
  access_key_id: string;
  secret_access_key: string;
}

export interface ByosConfigResponse {
  id: string;
  location_id: string;
  credential_id: string;
  provider: 's3';
  endpoint: string;
  bucket: string;
  region: string;
  key_prefix: string;
  force_path_style: boolean;
  credential_version: number;
  credentials_present: true;
  status: 'staged' | 'active' | 'retired' | 'failed';
  last_tested_at: string | null;
  last_error_code: string | null;
  activated_at: string | null;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
}
