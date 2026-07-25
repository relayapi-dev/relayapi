import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Bundle, ZObject } from 'zapier-platform-core';
import createPost from '../src/creates/createPost';
import accountOptions from '../src/triggers/accountOptions';
import uploadMedia from '../src/creates/uploadMedia';
import commentReceived from '../src/triggers/commentReceived';
import messageReceived from '../src/triggers/messageReceived';
import postFailed from '../src/triggers/postFailed';
import postPublished from '../src/triggers/postPublished';
import postRecycled from '../src/triggers/postRecycled';
import postScheduled from '../src/triggers/postScheduled';

const json = { stringify: JSON.stringify };
type OpenAPIOperation = {
  requestBody?: {
    content?: Record<
      string,
      {
        schema?: {
          properties?: Record<
            string,
            { type?: string; items?: { type?: string } }
          >;
          required?: string[];
        };
      }
    >;
  };
};
const openapi = JSON.parse(
  readFileSync(new URL('../../../../apps/docs/openapi.json', import.meta.url), 'utf8'),
) as {
  paths: Record<string, { post?: OpenAPIOperation; delete?: unknown }>;
};

describe('Zapier workflow contracts', () => {
  it('backs the account picker with a registered hidden trigger', () => {
    const targets = createPost.operation.inputFields.find(
      (field) => field.key === 'targets',
    );

    expect(targets?.dynamic).toBe('account_options.id.display_name');
    expect(accountOptions.key).toBe('account_options');
    expect(accountOptions.display.hidden).toBe(true);
  });

  it('sends Create Post targets as the API string array contract', async () => {
    const request = vi.fn(async () => ({ data: { id: 'post_123' } }));
    const z = { request, JSON: json } as unknown as ZObject;

    await createPost.operation.perform(z, {
      inputData: {
        content: 'Hello',
        targets: ['acc_one', 'acc_two'],
        scheduled_at: 'now',
      },
    } as unknown as Bundle);

    const options = request.mock.calls[0]?.[0] as { body: string };
    expect(JSON.parse(options.body)).toMatchObject({
      content: 'Hello',
      targets: ['acc_one', 'acc_two'],
      scheduled_at: 'now',
    });
    const targetsSchema =
      openapi.paths['/v1/posts']?.post?.requestBody?.content?.['application/json']
        ?.schema?.properties?.targets;
    expect(targetsSchema).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it.each([
    ['post published', postPublished],
    ['post failed', postFailed],
    ['post recycled', postRecycled],
    ['post scheduled', postScheduled],
    ['comment received', commentReceived],
    ['message received', messageReceived],
  ])('unsubscribes the %s hook through DELETE /v1/webhooks/{id}', async (_name, trigger) => {
    const request = vi.fn(async () => ({ data: undefined }));
    const z = {
      request,
      errors: { Error: class ZapierError extends Error {} },
    } as unknown as ZObject;

    await trigger.operation.performUnsubscribe(z, {
      subscribeData: { id: 'wh_test/id' },
    } as unknown as Bundle);

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toEqual({
      url: 'https://api.relayapi.dev/v1/webhooks/wh_test%2Fid',
      method: 'DELETE',
    });
    expect(openapi.paths['/v1/webhooks/{id}']?.delete).toBeDefined();
    expect(openapi.paths['/v1/webhooks']?.delete).toBeUndefined();
  });

  it('uploads the Zapier file bytes and confirms the presigned object', async () => {
    const fileBody = Readable.from(Buffer.from('image bytes'));
    const confirmed = {
      id: 'med_123',
      url: 'https://media.relayapi.dev/org_123/file_123/photo one.jpg',
      filename: 'photo one.jpg',
      mime_type: 'image/jpeg',
      size: 11,
      created_at: '2026-07-13T00:00:00.000Z',
    };
    const request = vi.fn(async (options: { url: string }) => {
      if (options.url.endsWith('/v1/media/presign')) {
        return {
          data: {
            upload_url: 'https://account.r2.cloudflarestorage.com/bucket/key?signature=1',
            upload_headers: {
              'Content-Type': 'image/jpeg',
              'If-None-Match': '*',
            },
            url: 'https://media.relayapi.dev/org_123/file_123/photo%20one.jpg',
          },
        };
      }
      if (options.url === 'https://files.zapier.com/photo') {
        return { body: fileBody, status: 200 };
      }
      if (options.url.includes('r2.cloudflarestorage.com')) {
        return { status: 200 };
      }
      if (options.url.endsWith('/v1/media/confirm')) {
        return { data: confirmed };
      }
      throw new Error(`Unexpected request: ${options.url}`);
    });
    const z = { request, JSON: json } as unknown as ZObject;

    const result = await uploadMedia.operation.perform(z, {
      inputData: {
        file: 'https://files.zapier.com/photo',
        filename: 'photo one.jpg',
        content_type: 'image/jpeg',
      },
    } as unknown as Bundle);

    expect(result).toEqual(confirmed);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[2]?.[0]).toMatchObject({
      method: 'PUT',
      headers: {
        'Content-Type': 'image/jpeg',
        'If-None-Match': '*',
      },
      body: fileBody,
      raw: true,
    });
    const confirmRequest = request.mock.calls[3]?.[0] as { body: string };
    expect(JSON.parse(confirmRequest.body)).toEqual({
      storage_key: 'org_123/file_123/photo one.jpg',
    });
    const confirmSchema =
      openapi.paths['/v1/media/confirm']?.post?.requestBody?.content?.[
        'application/json'
      ]?.schema;
    expect(openapi.paths['/v1/media/presign']?.post).toBeDefined();
    expect(confirmSchema?.required).toContain('storage_key');
    expect(confirmSchema?.properties?.storage_key?.type).toBe('string');
  });
});
