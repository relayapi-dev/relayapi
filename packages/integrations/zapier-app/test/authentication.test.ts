import { describe, it, expect } from '@jest/globals';

// Minimal mock of zapier-platform-core's createAppTester and tools
const zapier = require('zapier-platform-core');
zapier.tools = zapier.tools || { env: { inject: () => {} } };

import App from '../src/index';

const appTester = zapier.createAppTester(App);

describe('Authentication', () => {
  beforeAll(() => {
    zapier.tools.env.inject();
  });

  it('should pass the API key in the Authorization header', async () => {
    const bundle = {
      authData: {
        apiKey: 'rlay_live_test123',
      },
    };

    // Test the beforeRequest middleware directly
    const { addAuthHeader } = require('../src/lib/requestHelper');
    const request = { headers: {} };
    const result = addAuthHeader(request, {} as any, bundle);

    expect(result.headers).toHaveProperty('Authorization');
    expect(result.headers.Authorization).toBe('Bearer rlay_live_test123');
  });

  it('should handle 401 errors as ExpiredAuthError', () => {
    const { handleErrors } = require('../src/lib/requestHelper');

    const mockResponse = {
      status: 401,
      data: JSON.stringify({ error: { code: 'unauthorized', message: 'Invalid API key' } }),
    };

    const mockZ = {
      errors: {
        ExpiredAuthError: class ExpiredAuthError extends Error {
          constructor(message: string) {
            super(message);
            this.name = 'ExpiredAuthError';
          }
        },
        Error: class ZapierError extends Error {
          constructor(message: string, code?: string, status?: number) {
            super(message);
            this.name = 'ZapierError';
          }
        },
      },
    };

    expect(() => handleErrors(mockResponse, mockZ as any)).toThrow('Invalid API key');
  });

  it('should handle generic errors with status code', () => {
    const { handleErrors } = require('../src/lib/requestHelper');

    const mockResponse = {
      status: 422,
      data: { error: { code: 'validation_error', message: 'Content is required' } },
    };

    const mockZ = {
      errors: {
        ExpiredAuthError: class ExpiredAuthError extends Error {
          constructor(message: string) {
            super(message);
            this.name = 'ExpiredAuthError';
          }
        },
        Error: class ZapierError extends Error {
          constructor(message: string, code?: string, status?: number) {
            super(message);
            this.name = 'ZapierError';
          }
        },
      },
    };

    expect(() => handleErrors(mockResponse, mockZ as any)).toThrow('Content is required');
  });

  it('should pass through successful responses', () => {
    const { handleErrors } = require('../src/lib/requestHelper');

    const mockResponse = {
      status: 200,
      data: { plan: 'pro', requests_used: 150, requests_limit: 10000 },
    };

    const result = handleErrors(mockResponse, {} as any);
    expect(result).toBe(mockResponse);
    expect(result.data.plan).toBe('pro');
  });
});
