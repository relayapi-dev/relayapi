// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import type { Relay } from '../client';

export abstract class APIResource {
  protected _client: Relay;

  constructor(client: Relay) {
    this._client = client;
  }
}
