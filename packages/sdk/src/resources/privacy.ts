import { APIPromise } from '../core/api-promise';
import { APIResource } from '../core/resource';
import { RequestOptions } from '../internal/request-options';

export class Privacy extends APIResource {
  listActiveErasureHolds(
    query: PrivacyListActiveErasureHoldsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<ErasureHoldSummaryListResponse> {
    return this._client.get('/v1/privacy/erasure-holds', {
      query,
      ...options,
    });
  }
}

export interface PrivacyListActiveErasureHoldsParams {
  workspace_id?: string;
}

export interface ErasureHoldSummary {
  id: string;
  subject_kind: 'organization' | 'workspace';
  subject_id: string;
  reason_code: string;
  reason_summary: string;
  placed_at: string;
}

export interface ErasureHoldSummaryListResponse {
  held: boolean;
  holds: ErasureHoldSummary[];
}
