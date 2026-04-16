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
    body: OrgSettingsUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<OrgSettingsUpdateResponse> {
    return this._client.patch('/v1/org-settings', { body, ...options });
  }
}

export interface OrgSettingsData {
  require_workspace_id: boolean;
}

export interface OrgSettingsRetrieveResponse {
  data: OrgSettingsData;
}

export interface OrgSettingsUpdateResponse {
  data: OrgSettingsData;
}

export interface OrgSettingsUpdateParams {
  require_workspace_id?: boolean;
}

export declare namespace OrgSettings {
  export {
    type OrgSettingsData as OrgSettingsData,
    type OrgSettingsRetrieveResponse as OrgSettingsRetrieveResponse,
    type OrgSettingsUpdateResponse as OrgSettingsUpdateResponse,
    type OrgSettingsUpdateParams as OrgSettingsUpdateParams,
  };
}
