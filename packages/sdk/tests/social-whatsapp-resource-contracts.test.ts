import { describe, expect, it } from 'bun:test';
import Relay from '../src';
import type {
  WhatsAppGroupMessageParams,
  WhatsAppGroupPinParams,
} from '../src/resources/whatsapp/admin';

const API_KEY = ['rlay', 'test', 'social-whatsapp'].join('_');

describe('social and WhatsApp SDK resources', () => {
  it('wires the nested WhatsApp Admin and Flow resources', () => {
    const client = new Relay({ apiKey: API_KEY });
    expect(client.whatsapp.admin).toBeDefined();
    expect(client.whatsapp.flows).toBeDefined();
    expect(Relay.Whatsapp.Admin).toBeDefined();
    expect(Relay.Whatsapp.Flows).toBeDefined();
  });

  it('maps durable post, inbox, and WhatsApp mutations with idempotency headers', async () => {
    const requests: Array<{
      body: unknown;
      idempotencyKey: string | null;
      method: string;
      url: URL;
    }> = [];
    const client = new Relay({
      apiKey: API_KEY,
      baseURL: 'https://api.example.test',
      maxRetries: 0,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const bodyText = await request.text();
        requests.push({
          body: bodyText ? JSON.parse(bodyText) : null,
          idempotencyKey: request.headers.get('Idempotency-Key'),
          method: request.method,
          url: new URL(request.url),
        });
        return Response.json({});
      },
    });

    await client.posts.editPublished('post_1', {
      idempotency_key: 'edit-post',
      targets: [{ target_id: 'pt_1', content: 'replacement' }],
    });
    await client.inbox.conversations.editMessage('conv_1', 'msg_1', {
      idempotency_key: 'edit-message',
      text: 'edited',
    });
    await client.inbox.comments.moderate('comment_1', {
      idempotency_key: 'moderate-comment',
      account_id: 'acc_1',
      action: 'hide',
    });
    await client.inbox.engagePost('provider-post-1', {
      idempotency_key: 'engage-post',
      account_id: 'acc_1',
      action: 'like',
    });
    await client.whatsapp.admin.createGroup({
      idempotency_key: 'create-group',
      account_id: 'acc_wa',
      subject: 'Customers',
    });
    await client.whatsapp.admin.unblockUsers({
      idempotency_key: 'unblock-users',
      account_id: 'acc_wa',
      users: [{ user: 'bsuid-1' }],
    });

    expect(
      requests.map(
        ({ method, url, idempotencyKey }) =>
          `${method} ${url.pathname} ${idempotencyKey}`,
      ),
    ).toEqual([
      'POST /v1/posts/post_1/edits edit-post',
      'PATCH /v1/inbox/conversations/conv_1/messages/msg_1 edit-message',
      'POST /v1/inbox/comments/comment_1/moderation moderate-comment',
      'PUT /v1/inbox/posts/provider-post-1/engagement engage-post',
      'POST /v1/whatsapp/admin/groups create-group',
      'DELETE /v1/whatsapp/admin/block-users unblock-users',
    ]);
    expect(requests[0]?.body).toEqual({
      targets: [{ target_id: 'pt_1', content: 'replacement' }],
    });
    expect(requests[5]?.body).toEqual({
      account_id: 'acc_wa',
      users: [{ user: 'bsuid-1' }],
    });
  });

  it('types exact media references and pin expiration semantics', () => {
    const document: WhatsAppGroupMessageParams = {
      idempotency_key: 'document',
      account_id: 'acc_wa',
      type: 'document',
      media: { id: 'media_1', filename: 'guide.pdf' },
    };
    const pin: WhatsAppGroupPinParams = {
      idempotency_key: 'pin',
      account_id: 'acc_wa',
      message_id: 'wamid.1',
      action: 'pin',
      expiration_days: 7,
    };
    expect(document.type).toBe('document');
    expect(pin.expiration_days).toBe(7);
  });
});
