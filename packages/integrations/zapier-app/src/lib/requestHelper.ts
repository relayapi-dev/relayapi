import { Bundle, HttpRequestOptions, HttpResponse, ZObject } from 'zapier-platform-core';

/**
 * Adds the Authorization header with the user's API key to every outgoing request.
 */
export const addAuthHeader = (
  request: HttpRequestOptions,
  z: ZObject,
  bundle: Bundle,
): HttpRequestOptions => {
  if (bundle.authData?.apiKey) {
    request.headers = {
      ...request.headers,
      Authorization: `Bearer ${bundle.authData.apiKey}`,
    };
  }
  return request;
};

/**
 * Inspects every response for errors and throws a user-friendly Zapier error
 * when the API returns a non-success status code.
 */
export const handleErrors = (response: HttpResponse, z: ZObject): HttpResponse => {
  if (response.status >= 400) {
    let message = `Request failed with status ${response.status}`;

    try {
      const body =
        typeof response.data === 'string' ? JSON.parse(response.data) : response.data;

      if (body?.error?.message) {
        message = body.error.message;
      }
    } catch {
      // body wasn't JSON — use the default message
    }

    if (response.status === 401) {
      throw new z.errors.ExpiredAuthError(message);
    }

    throw new z.errors.Error(message, 'ApiError', response.status);
  }

  return response;
};
