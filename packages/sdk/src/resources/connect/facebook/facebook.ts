// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import * as PagesAPI from './pages';
import { PageListResponse, PageSelectParams, PageSelectResponse, Pages } from './pages';

export class Facebook extends APIResource {
  pages: PagesAPI.Pages = new PagesAPI.Pages(this._client);
}

Facebook.Pages = Pages;

export declare namespace Facebook {
  export {
    Pages as Pages,
    type PageListResponse as PageListResponse,
    type PageSelectResponse as PageSelectResponse,
    type PageSelectParams as PageSelectParams,
  };
}
