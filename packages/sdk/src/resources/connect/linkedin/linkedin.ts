// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import * as OrganizationsAPI from './organizations';
import {
  OrganizationListResponse,
  OrganizationSelectParams,
  OrganizationSelectResponse,
  Organizations,
} from './organizations';

export class Linkedin extends APIResource {
  organizations: OrganizationsAPI.Organizations = new OrganizationsAPI.Organizations(this._client);
}

Linkedin.Organizations = Organizations;

export declare namespace Linkedin {
  export {
    Organizations as Organizations,
    type OrganizationListResponse as OrganizationListResponse,
    type OrganizationSelectResponse as OrganizationSelectResponse,
    type OrganizationSelectParams as OrganizationSelectParams,
  };
}
