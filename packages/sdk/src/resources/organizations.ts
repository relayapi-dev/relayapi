// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class Organizations extends APIResource {
  /**
   * Delete an organization. The initiating owner or system-administrator
   * credential is revalidated transactionally through destructive admission.
   */
  delete(id: string, options?: RequestOptions): APIPromise<OrganizationDeletionResponse> {
    return this._client.delete(path`/v1/organizations/${id}`, options);
  }
}

export interface OrganizationDeletionResponse {
  status: 'tombstoned' | 'held';
}

export declare namespace Organizations {
  export { type OrganizationDeletionResponse as OrganizationDeletionResponse };
}
