import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';

export class OrgSettings extends APIResource {
  /**
   * Get organization settings
   */
  retrieve(options?: RequestOptions): APIPromise<OrgSettingsRetrieveResponse> {
    return this._client.get('/v1/org-settings', options);
  }

  /**
   * Update organization settings
   */
  update(
    body: OrgSettingsUpdateParams,
    options?: RequestOptions,
  ): APIPromise<OrgSettingsUpdateResponse> {
    return this._client.patch('/v1/org-settings', { body, ...options });
  }
}

export interface OrgSettingsData {
  /** When false, omitted workspace IDs remain valid and create organization-scoped roots. */
  require_workspace_id: boolean;
  /** Compare-and-swap revision required when updating organization settings. */
  revision: number;
}

export interface OrgSettingsRetrieveResponse {
  data: OrgSettingsData;
}

export interface OrgSettingsUpdateResponse {
  data: OrgSettingsData;
}

export interface OrgSettingsUpdateParams {
  /** Enable only after all active operational roots have an explicit workspace. */
  require_workspace_id: boolean;
  /** Revision returned by the latest retrieve or update call. */
  expected_revision: number;
}

export declare namespace OrgSettings {
  export {
    type OrgSettingsData as OrgSettingsData,
    type OrgSettingsRetrieveResponse as OrgSettingsRetrieveResponse,
    type OrgSettingsUpdateResponse as OrgSettingsUpdateResponse,
    type OrgSettingsUpdateParams as OrgSettingsUpdateParams,
  };
}
