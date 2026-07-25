import type { Bundle, ZObject } from 'zapier-platform-core';

const perform = async (z: ZObject, bundle: Bundle) => {
  const { file, filename, content_type } = bundle.inputData as {
    file: string;
    filename: string;
    content_type: string;
  };
  const contentType = content_type || 'image/jpeg';

  const presignResponse = await z.request({
    url: 'https://api.relayapi.dev/v1/media/presign',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: z.JSON.stringify({
      filename,
      content_type: contentType,
    }),
  });

  const presign = presignResponse.data as {
    upload_url: string;
    upload_headers: { 'Content-Type': string; 'If-None-Match': '*' };
    url: string;
  };

  // Zapier file fields contain a temporary, authenticated download URL. Stream
  // that response into R2 so large files are not copied into an extra Buffer.
  const fileResponse = await z.request({
    url: file,
    method: 'GET',
    raw: true,
  });
  const contentLength = fileResponse.headers?.get('content-length');

  await z.request({
    url: presign.upload_url,
    method: 'PUT',
    headers: {
      ...presign.upload_headers,
      ...(contentLength && /^\d+$/.test(contentLength)
        ? { 'Content-Length': contentLength }
        : {}),
    },
    body: fileResponse.body,
    raw: true,
  });

  const storageKey = decodeURIComponent(new URL(presign.url).pathname.slice(1));
  const confirmResponse = await z.request({
    url: 'https://api.relayapi.dev/v1/media/confirm',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: z.JSON.stringify({ storage_key: storageKey }),
  });

  return confirmResponse.data;
};

const uploadMedia = {
  key: 'upload_media',
  noun: 'Media',

  display: {
    label: 'Upload Media',
    description:
      'Upload a media file to RelayAPI and return the confirmed media record.',
  },

  operation: {
    inputFields: [
      {
        key: 'file',
        label: 'File',
        type: 'file' as const,
        required: true,
        helpText: 'The image, video, audio file, or PDF to upload.',
      },
      {
        key: 'filename',
        label: 'Filename',
        type: 'string' as const,
        required: true,
        helpText: 'Name of the file including extension (e.g. photo.jpg).',
      },
      {
        key: 'content_type',
        label: 'Content Type',
        type: 'string' as const,
        required: true,
        default: 'image/jpeg',
        helpText:
          'MIME type of the file (e.g. image/jpeg, image/png, video/mp4).',
      },
    ],

    perform,

    sample: {
      id: 'med_abc123',
      url: 'https://media.relayapi.dev/ws_123/med_abc.jpg',
      filename: 'photo.jpg',
      mime_type: 'image/jpeg',
      size: 123456,
      created_at: '2025-01-01T00:00:00Z',
    },
  },
};

export default uploadMedia;
