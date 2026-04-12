import { Bundle, ZObject } from 'zapier-platform-core';

const perform = async (z: ZObject, bundle: Bundle) => {
  const { filename, content_type } = bundle.inputData;

  const response = await z.request({
    url: 'https://api.relayapi.dev/v1/media/presign',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: z.JSON.stringify({
      filename,
      content_type: content_type || 'image/jpeg',
    }),
  });

  return response.data;
};

const uploadMedia = {
  key: 'upload_media',
  noun: 'Media',

  display: {
    label: 'Upload Media',
    description:
      'Get a presigned upload URL for a media file. Use the returned URL with the Create Post action.',
  },

  operation: {
    inputFields: [
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
      upload_url: 'https://storage.example.com/upload?token=abc',
      url: 'https://media.relayapi.dev/ws_123/med_abc.jpg',
    },
  },
};

export default uploadMedia;
