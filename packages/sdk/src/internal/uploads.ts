import { type MultipartFormDataOptions, type RequestOptions } from './request-options';
import type { FilePropertyBag, Fetch } from './builtin-types';
import type { Relay } from '../client';
import { ReadableStreamFrom } from './shims';

export type BlobPart = string | ArrayBuffer | ArrayBufferView | Blob | DataView;
type FsReadStream = AsyncIterable<Uint8Array> & { path: string | { toString(): string } };

// https://github.com/oven-sh/bun/issues/5980
interface BunFile extends Blob {
  readonly name?: string | undefined;
}

interface BlobLike {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface ResponseLike {
  readonly url?: string;
  blob(): Promise<BlobLike>;
}

export const checkFileSupport = () => {
  if (typeof File === 'undefined') {
    const { process } = globalThis as any;
    const isOldNode =
      typeof process?.versions?.node === 'string' && parseInt(process.versions.node.split('.')) < 20;
    throw new Error(
      '`File` is not defined as a global, which is required for file uploads.' +
        (isOldNode ?
          " Update to Node 20 LTS or newer, or set `globalThis.File` to `import('node:buffer').File`."
        : ''),
    );
  }
};

/**
 * Typically, this is a native "File" class.
 *
 * We provide the {@link toFile} utility to convert a variety of objects
 * into the File class.
 *
 * For convenience, you can also pass a fetch Response, or in Node,
 * the result of fs.createReadStream().
 */
export type Uploadable = File | Response | FsReadStream | BunFile | BlobLike | ResponseLike;

/**
 * Construct a `File` instance. This is used to ensure a helpful error is thrown
 * for environments that don't define a global `File` yet.
 */
export function makeFile(
  fileBits: BlobPart[],
  fileName: string | undefined,
  options?: FilePropertyBag,
): File {
  checkFileSupport();
  return new File(fileBits as any, fileName ?? 'unknown_file', options);
}

export function getName(value: any): string | undefined {
  return (
    (
      (typeof value === 'object' &&
        value !== null &&
        (('name' in value && value.name && String(value.name)) ||
          ('url' in value && value.url && String(value.url)) ||
          ('filename' in value && value.filename && String(value.filename)) ||
          ('path' in value && value.path && String(value.path)))) ||
      ''
    )
      .split(/[\\/]/)
      .pop() || undefined
  );
}

export const isAsyncIterable = (value: any): value is AsyncIterable<any> =>
  value != null && typeof value === 'object' && typeof value[Symbol.asyncIterator] === 'function';

/**
 * Returns a multipart/form-data request if any part of the given request body contains a File / Blob value.
 * Otherwise returns the request as is.
 */
export const maybeMultipartFormRequestOptions = async (
  opts: RequestOptions,
  fetch: Relay | Fetch,
): Promise<RequestOptions> => {
  const { multipartFormData, ...requestOptions } = opts;
  if (!hasUploadableValue(opts.body)) return requestOptions;

  return { ...requestOptions, body: await createForm(opts.body, fetch, multipartFormData) };
};

type MultipartFormRequestOptions = Omit<RequestOptions, 'body'> & { body: unknown };

export const multipartFormRequestOptions = async (
  opts: MultipartFormRequestOptions,
  fetch: Relay | Fetch,
): Promise<RequestOptions> => {
  const { multipartFormData, ...requestOptions } = opts;
  return { ...requestOptions, body: await createForm(opts.body, fetch, multipartFormData) };
};

const supportsFormDataMap = /* @__PURE__ */ new WeakMap<Fetch, Promise<boolean>>();

/**
 * node-fetch doesn't support the global FormData object in recent node versions. Instead of sending
 * properly-encoded form data, it just stringifies the object, resulting in a request body of "[object FormData]".
 * This function detects if the fetch function provided supports the global FormData object to avoid
 * confusing error messages later on.
 */
function supportsFormData(fetchObject: Relay | Fetch): Promise<boolean> {
  const fetch: Fetch = typeof fetchObject === 'function' ? fetchObject : (fetchObject as any).fetch;
  const cached = supportsFormDataMap.get(fetch);
  if (cached) return cached;
  const promise = (async () => {
    try {
      const FetchResponse = (
        'Response' in fetch ?
          fetch.Response
        : (await fetch('data:,')).constructor) as typeof Response;
      const data = new FormData();
      if (data.toString() === (await new FetchResponse(data).text())) {
        return false;
      }
      return true;
    } catch {
      // avoid false negatives
      return true;
    }
  })();
  supportsFormDataMap.set(fetch, promise);
  return promise;
}

export const createForm = async <T = Record<string, unknown>>(
  body: T | undefined,
  fetch: Relay | Fetch,
  options: MultipartFormDataOptions = {},
): Promise<FormData> => {
  if (!(await supportsFormData(fetch))) {
    throw new TypeError(
      'The provided fetch function does not support file uploads with the current global FormData class.',
    );
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(body || {})) {
    await addFormValue(form, key, value, options);
  }
  return form;
};

const isNativeBlob = (value: unknown): value is Blob =>
  typeof Blob !== 'undefined' && value instanceof Blob;

// Structural checks allow uploads created by another fetch implementation or
// JavaScript realm. FormData still receives a native Blob/File below.
const isBlobLike = (value: unknown): value is BlobLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as BlobLike).size === 'number' &&
  typeof (value as BlobLike).type === 'string' &&
  typeof (value as BlobLike).arrayBuffer === 'function';

const isResponseLike = (value: unknown): value is ResponseLike =>
  typeof value === 'object' && value !== null && typeof (value as ResponseLike).blob === 'function';

const isUploadable = (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  (isResponseLike(value) || isAsyncIterable(value) || isBlobLike(value));

const hasUploadableValue = (value: unknown): boolean => {
  if (isUploadable(value)) return true;
  if (Array.isArray(value)) return value.some(hasUploadableValue);
  if (value && typeof value === 'object') {
    for (const k in value) {
      if (hasUploadableValue((value as any)[k])) return true;
    }
  }
  return false;
};

const addFormValue = async (
  form: FormData,
  key: string,
  value: unknown,
  options: MultipartFormDataOptions,
): Promise<void> => {
  if (value === undefined) return;
  if (value == null) {
    throw new TypeError(
      `Received null for "${key}"; to pass null in FormData, you must use the string 'null'`,
    );
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    form.append(key, String(value));
  } else if (isResponseLike(value)) {
    const blob = await value.blob();
    if (!isBlobLike(blob)) {
      throw new TypeError(`Response-like upload for "${key}" returned an invalid Blob`);
    }
    form.append(
      key,
      makeFile(
        [isNativeBlob(blob) ? blob : await blob.arrayBuffer()],
        getName(value),
        blob.type ? { type: blob.type } : undefined,
      ),
    );
  } else if (isAsyncIterable(value)) {
    form.append(key, makeFile([await new Response(ReadableStreamFrom(value)).blob()], getName(value)));
  } else if (isBlobLike(value)) {
    const name = getName(value);
    if (isNativeBlob(value)) {
      if (name) {
        form.append(key, value, name);
      } else {
        form.append(key, value);
      }
    } else {
      form.append(
        key,
        makeFile([await value.arrayBuffer()], name, value.type ? { type: value.type } : undefined),
      );
    }
  } else if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      await addFormValue(form, getArrayKey(key, index, options.arrayFormat), entry, options);
    }
  } else if (typeof value === 'object') {
    for (const [name, prop] of Object.entries(value)) {
      await addFormValue(form, getObjectKey(key, name, options.objectFormat), prop, options);
    }
  } else {
    throw new TypeError(
      `Invalid value given to form, expected a string, number, boolean, object, Array, File or Blob but got ${value} instead`,
    );
  }
};

function getArrayKey(
  key: string,
  index: number,
  format: MultipartFormDataOptions['arrayFormat'] = 'brackets',
): string {
  if (format === 'brackets') return `${key}[]`;
  if (format === 'indices') return `${key}[${index}]`;
  if (format === 'repeat') return key;
  throw new TypeError(`Unsupported multipart array format: ${String(format)}`);
}

function getObjectKey(
  key: string,
  name: string,
  format: MultipartFormDataOptions['objectFormat'] = 'brackets',
): string {
  if (format === 'brackets') return `${key}[${name}]`;
  if (format === 'dots') return `${key}.${name}`;
  throw new TypeError(`Unsupported multipart object format: ${String(format)}`);
}
