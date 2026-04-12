// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';

export class BusinessProfile extends APIResource {
  /**
   * Get WhatsApp Business profile
   */
  retrieve(
    query: BusinessProfileRetrieveParams,
    options?: RequestOptions,
  ): APIPromise<BusinessProfileRetrieveResponse> {
    return this._client.get('/v1/whatsapp/business-profile', { query, ...options });
  }

  /**
   * Update WhatsApp Business profile
   */
  update(
    body: BusinessProfileUpdateParams,
    options?: RequestOptions,
  ): APIPromise<BusinessProfileUpdateResponse> {
    return this._client.put('/v1/whatsapp/business-profile', { body, ...options });
  }

  /**
   * Get display name and review status
   */
  getDisplayName(
    query: BusinessProfileGetDisplayNameParams,
    options?: RequestOptions,
  ): APIPromise<BusinessProfileDisplayNameResponse> {
    return this._client.get('/v1/whatsapp/business-profile/display-name', { query, ...options });
  }

  /**
   * Request display name change (requires Meta review)
   */
  updateDisplayName(
    body: BusinessProfileUpdateDisplayNameParams,
    options?: RequestOptions,
  ): APIPromise<BusinessProfileUpdateDisplayNameResponse> {
    return this._client.post('/v1/whatsapp/business-profile/display-name', { body, ...options });
  }

  /**
   * Upload WhatsApp Business profile photo
   */
  uploadPhoto(
    body: BusinessProfileUploadPhotoParams,
    options?: RequestOptions,
  ): APIPromise<BusinessProfileUploadPhotoResponse> {
    return this._client.post('/v1/whatsapp/business-profile/photo', { body, ...options });
  }
}

export interface BusinessProfileRetrieveResponse {
  /**
   * About text
   */
  about?: string | null;

  /**
   * Business address
   */
  address?: string | null;

  /**
   * Description
   */
  description?: string | null;

  /**
   * Business email
   */
  email?: string | null;

  /**
   * Profile picture URL
   */
  profile_picture_url?: string | null;

  /**
   * Website URLs
   */
  websites?: Array<string>;
}

export interface BusinessProfileUpdateResponse {
  /**
   * About text
   */
  about?: string | null;

  /**
   * Business address
   */
  address?: string | null;

  /**
   * Description
   */
  description?: string | null;

  /**
   * Business email
   */
  email?: string | null;

  /**
   * Profile picture URL
   */
  profile_picture_url?: string | null;

  /**
   * Website URLs
   */
  websites?: Array<string>;
}

export interface BusinessProfileRetrieveParams {
  /**
   * WhatsApp account ID
   */
  account_id: string;
}

export interface BusinessProfileUpdateParams {
  /**
   * WhatsApp account ID
   */
  account_id: string;

  about?: string;

  address?: string;

  description?: string;

  email?: string;

  websites?: Array<string>;
}

export interface BusinessProfileDisplayNameResponse {
  display_name: string | null;
  review_status?: string | null;
}

export interface BusinessProfileGetDisplayNameParams {
  account_id: string;
}

export interface BusinessProfileUpdateDisplayNameParams {
  account_id: string;
  display_name: string;
}

export interface BusinessProfileUpdateDisplayNameResponse {
  success: boolean;
  message: string;
}

export interface BusinessProfileUploadPhotoParams {
  account_id: string;
  photo_url: string;
}

export interface BusinessProfileUploadPhotoResponse {
  success: boolean;
  profile_picture_url: string | null;
}

export declare namespace BusinessProfile {
  export {
    type BusinessProfileRetrieveResponse as BusinessProfileRetrieveResponse,
    type BusinessProfileUpdateResponse as BusinessProfileUpdateResponse,
    type BusinessProfileDisplayNameResponse as BusinessProfileDisplayNameResponse,
    type BusinessProfileUpdateDisplayNameResponse as BusinessProfileUpdateDisplayNameResponse,
    type BusinessProfileUploadPhotoResponse as BusinessProfileUploadPhotoResponse,
    type BusinessProfileRetrieveParams as BusinessProfileRetrieveParams,
    type BusinessProfileUpdateParams as BusinessProfileUpdateParams,
    type BusinessProfileGetDisplayNameParams as BusinessProfileGetDisplayNameParams,
    type BusinessProfileUpdateDisplayNameParams as BusinessProfileUpdateDisplayNameParams,
    type BusinessProfileUploadPhotoParams as BusinessProfileUploadPhotoParams,
  };
}
