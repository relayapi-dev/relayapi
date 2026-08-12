import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Bundle, ZObject } from 'zapier-platform-core';
import createPost, { parseMediaItems, parseTargetOptions } from '../src/creates/createPost';
import deletePost from '../src/creates/deletePost';
import updatePost from '../src/creates/updatePost';
import accountOptions from '../src/triggers/accountOptions';
import postOptions from '../src/triggers/postOptions';
import findAccount from '../src/searches/findAccount';
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
          properties?: Record<string, { type?: string; items?: { type?: string } }>;
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
  it('offers every registered publishing platform, including Slack', () => {
    const platformField = findAccount.operation.inputFields.find(
      (field) => field.key === 'platform',
    );
    const choices = platformField?.choices ?? {};

    expect(Object.keys(choices)).toHaveLength(22);
    expect(choices).toHaveProperty('slack', 'Slack');
  });

  it('backs the account picker with a registered hidden trigger', () => {
    const targets = createPost.operation.inputFields.find((field) => field.key === 'targets');

    expect(targets?.dynamic).toBe('account_options.id.display_name');
    expect(accountOptions.key).toBe('account_options');
    expect(accountOptions.display.hidden).toBe(true);
  });

  it('backs update and delete post pickers with a registered hidden trigger', () => {
    const updatePostId = updatePost.operation.inputFields.find((field) => field.key === 'postId');
    const deletePostId = deletePost.operation.inputFields.find((field) => field.key === 'postId');

    expect(updatePostId?.dynamic).toBe('post_options.id.display_name');
    expect(deletePostId?.dynamic).toBe('post_options.id.display_name');
    expect(postOptions.key).toBe('post_options');
    expect(postOptions.display.hidden).toBe(true);
  });

  it('returns readable labels from the hidden post picker trigger', async () => {
    const request = vi.fn(async () => ({
      data: {
        data: [
          {
            id: 'post_123',
            status: 'scheduled',
            content: 'Launch announcement',
          },
        ],
      },
    }));
    const z = { request, JSON: json } as unknown as ZObject;

    const posts = await postOptions.operation.perform(z, {
      inputData: {},
    } as unknown as Bundle);

    expect(posts).toEqual([
      {
        id: 'post_123',
        status: 'scheduled',
        content: 'Launch announcement',
        display_name: 'Launch announcement (scheduled)',
      },
    ]);
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
      openapi.paths['/v1/posts']?.post?.requestBody?.content?.['application/json']?.schema
        ?.properties?.targets;
    expect(targetsSchema).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('forwards typed audio media and validated target_options', async () => {
    const request = vi.fn(async () => ({ data: { id: 'post_123' } }));
    const z = { request, JSON: json } as unknown as ZObject;
    const targetOptions = {
      whatsapp: { to: '15551234567' },
      snapchat: { content_type: 'saved_story' },
      tiktok: {
        privacy_level: 'SELF_ONLY',
        allow_comment: true,
        allow_duet: false,
        allow_stitch: false,
        brand_content_toggle: false,
        brand_organic_toggle: false,
        content_preview_confirmed: true,
        express_consent_given: true,
      },
    };
    const mediaItems = [
      {
        url: 'https://example.com/voice.mp3',
        type: 'audio',
        mime_type: 'audio/mpeg',
      },
    ];

    await createPost.operation.perform(z, {
      inputData: {
        content: '',
        targets: ['whatsapp'],
        scheduled_at: 'now',
        timezone: 'UTC',
        target_options: JSON.stringify(targetOptions),
        media_items: JSON.stringify(mediaItems),
      },
    } as unknown as Bundle);

    const options = request.mock.calls[0]?.[0] as { body: string };
    expect(JSON.parse(options.body)).toEqual({
      targets: ['whatsapp'],
      scheduled_at: 'now',
      timezone: 'UTC',
      target_options: targetOptions,
      media: mediaItems,
    });

    const targetOptionsField = createPost.operation.inputFields.find(
      (field) => field.key === 'target_options',
    );
    const mediaItemsField = createPost.operation.inputFields.find(
      (field) => field.key === 'media_items',
    );
    expect(targetOptionsField).toMatchObject({
      type: 'json',
      schema: { type: 'object' },
    });
    expect(mediaItemsField).toMatchObject({
      type: 'json',
      schema: { type: 'array', maxItems: 50 },
    });
  });

  it('rejects invalid target_options and typed media before making a request', () => {
    expect(() => parseTargetOptions('[{"to":"15551234567"}]')).toThrow('must be a JSON object');
    expect(() => parseTargetOptions('{"whatsapp":null}')).toThrow(
      'must map each platform, account, or workspace target',
    );
    expect(() => parseMediaItems('[{"url":"file:///tmp/audio.mp3","type":"audio"}]')).toThrow(
      'URL must use HTTP or HTTPS',
    );
    expect(() =>
      parseMediaItems('[{"url":"https://example.com/file.bin","type":"binary"}]'),
    ).toThrow('type must be image, video, gif, document, or audio');
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
      openapi.paths['/v1/media/confirm']?.post?.requestBody?.content?.['application/json']?.schema;
    expect(openapi.paths['/v1/media/presign']?.post).toBeDefined();
    expect(confirmSchema?.required).toContain('storage_key');
    expect(confirmSchema?.properties?.storage_key?.type).toBe('string');
  });
});
