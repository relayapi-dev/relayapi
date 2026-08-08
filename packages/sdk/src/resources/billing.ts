// Hand-written scaffold matching /v1/billing routes. Superseded by Stainless
// regeneration on the next OpenAPI pass.

import { APIPromise } from '../core/api-promise';
import { APIResource } from '../core/resource';
import { RequestOptions } from '../internal/request-options';

export class Billing extends APIResource {
  status(options?: RequestOptions): APIPromise<BillingStatusResponse> {
    return this._client.get('/v1/billing', options);
  }

  checkout(options?: RequestOptions): APIPromise<BillingURLResponse> {
    return this._client.post('/v1/billing/checkout', options);
  }

  portal(options?: RequestOptions): APIPromise<BillingURLResponse> {
    return this._client.post('/v1/billing/portal', options);
  }

  /**
   * Reconciles the local entitlement and usage authority with Stripe.
   *
   * If canonical authority cannot be established immediately, the API returns
   * `BILLING_AUTHORITY_PENDING` with HTTP 503 and a `Retry-After` header.
   */
  sync(options?: RequestOptions): APIPromise<BillingSyncResponse> {
    return this._client.post('/v1/billing/sync', options);
  }
}

export interface BillingSubscription {
  status: 'trialing' | 'active' | 'past_due' | 'cancelled';
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  has_stripe_customer: boolean;
  has_stripe_subscription: boolean;
  community?: boolean;
}

export interface BillingInvoice {
  id: string;
  status: string;
  period_start: string;
  period_end: string;
  total_cents: number;
  stripe_hosted_url: string | null;
  paid_at: string | null;
  created_at: string;
}

export interface BillingStatusResponse {
  subscription: BillingSubscription | null;
  invoices: BillingInvoice[];
}

export interface BillingURLResponse {
  url: string;
}

export interface BillingSyncResponse {
  plan: 'free' | 'pro';
}

export declare namespace Billing {
  export {
    type BillingSubscription as BillingSubscription,
    type BillingInvoice as BillingInvoice,
    type BillingStatusResponse as BillingStatusResponse,
    type BillingURLResponse as BillingURLResponse,
    type BillingSyncResponse as BillingSyncResponse,
  };
}
