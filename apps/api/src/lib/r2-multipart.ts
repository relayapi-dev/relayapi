/**
 * Cloudflare Workers R2 appends the numeric provider code to `Error.message`.
 * https://developers.cloudflare.com/r2/api/error-codes/#multipart-upload-errors
 */
export function isR2NoSuchUploadError(error: unknown): boolean {
	return error instanceof Error && /\(10024\)\s*$/.test(error.message);
}
