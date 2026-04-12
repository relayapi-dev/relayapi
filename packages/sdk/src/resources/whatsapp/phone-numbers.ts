// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { buildHeaders } from '../../internal/headers';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class PhoneNumbers extends APIResource {
  /**
   * List purchased phone numbers
   */
  list(
    query?: PhoneNumberListParams,
    options?: RequestOptions,
  ): APIPromise<PhoneNumberListResponse> {
    return this._client.get('/v1/whatsapp/phone-numbers', { query, ...options });
  }

  /**
   * Purchase a US phone number
   */
  purchase(
    body: PhoneNumberPurchaseParams,
    options?: RequestOptions,
  ): APIPromise<PhoneNumberPurchaseResponse> {
    return this._client.post('/v1/whatsapp/phone-numbers/purchase', { body, ...options });
  }

  /**
   * Get phone number status
   */
  retrieve(
    phoneNumberID: string,
    options?: RequestOptions,
  ): APIPromise<PhoneNumberRetrieveResponse> {
    return this._client.get(path`/v1/whatsapp/phone-numbers/${phoneNumberID}`, options);
  }

  /**
   * Request verification code via SMS or voice
   */
  requestCode(
    phoneNumberID: string,
    body: PhoneNumberRequestCodeParams,
    options?: RequestOptions,
  ): APIPromise<PhoneNumberRequestCodeResponse> {
    return this._client.post(path`/v1/whatsapp/phone-numbers/${phoneNumberID}/request-code`, {
      body,
      ...options,
    });
  }

  /**
   * Submit verification code
   */
  verify(
    phoneNumberID: string,
    body: PhoneNumberVerifyParams,
    options?: RequestOptions,
  ): APIPromise<PhoneNumberVerifyResponse> {
    return this._client.post(path`/v1/whatsapp/phone-numbers/${phoneNumberID}/verify`, {
      body,
      ...options,
    });
  }

  /**
   * Release a phone number
   */
  release(
    phoneNumberID: string,
    options?: RequestOptions,
  ): APIPromise<PhoneNumberReleaseResponse> {
    return this._client.delete(path`/v1/whatsapp/phone-numbers/${phoneNumberID}`, options);
  }
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface PhoneNumberResource {
  /**
   * Phone number resource ID
   */
  id: string;

  /**
   * E.164 phone number
   */
  phone_number: string;

  /**
   * Provisioning status
   */
  status:
    | 'purchasing'
    | 'pending_verification'
    | 'verified'
    | 'active'
    | 'releasing'
    | 'released';

  /**
   * Carrier provider
   */
  provider: string;

  /**
   * ISO country code
   */
  country: string;

  /**
   * Monthly cost in cents
   */
  monthly_cost_cents: number;

  /**
   * Created timestamp
   */
  created_at: string;

  /**
   * Meta WhatsApp phone number ID
   */
  wa_phone_number_id?: string | null;

  /**
   * Linked RelayAPI social account ID
   */
  social_account_id?: string | null;
}

export interface PhoneNumberListResponse {
  data: Array<PhoneNumberResource>;
}

export interface PhoneNumberPurchaseResponse {
  /**
   * Phone number resource ID
   */
  id: string;

  /**
   * Purchased phone number
   */
  phone_number: string;

  /**
   * Current status
   */
  status: string;

  /**
   * Stripe checkout URL (first number only)
   */
  checkout_url?: string | null;
}

export type PhoneNumberRetrieveResponse = PhoneNumberResource;

export interface PhoneNumberRequestCodeResponse {
  success: boolean;
}

export interface PhoneNumberVerifyResponse {
  success: boolean;
  status: string;
}

export type PhoneNumberReleaseResponse = PhoneNumberResource;

// ---------------------------------------------------------------------------
// Request params
// ---------------------------------------------------------------------------

export interface PhoneNumberListParams {
  /**
   * Filter by provisioning status
   */
  status?:
    | 'purchasing'
    | 'pending_verification'
    | 'verified'
    | 'active'
    | 'releasing'
    | 'released';
}

export interface PhoneNumberPurchaseParams {
  /**
   * WhatsApp social account ID (for WABA credentials)
   */
  account_id: string;

  /**
   * Country code (only US supported)
   */
  country?: 'US';

  /**
   * 3-digit US area code preference
   */
  area_code?: string;
}

export interface PhoneNumberRequestCodeParams {
  /**
   * Verification code delivery method
   */
  method: 'sms' | 'voice';
}

export interface PhoneNumberVerifyParams {
  /**
   * 6-digit verification code
   */
  code: string;
}
