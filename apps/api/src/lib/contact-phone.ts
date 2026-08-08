import { parsePhoneNumberFromString } from "libphonenumber-js/max";

export interface ContactPhoneNormalizationOptions {
	/**
	 * Provider identifiers such as WhatsApp wa_id omit the leading plus while
	 * still carrying the full country calling code. Human-entered contact
	 * fields should leave this disabled because a bare national number has no
	 * unambiguous country.
	 */
	allowBareInternational?: boolean;
}

const PHONE_PRESENTATION_CHARS = /^[+\d\s().-]+$/;

/**
 * Normalize an international phone identity to E.164.
 *
 * The encrypted contact value remains available for display after application
 * decryption. This function supplies the normalized input to the keyed
 * `contacts.phone_hash` equality authority; no database regex or
 * digit-stripping heuristic attempts to infer numbering semantics.
 */
export function normalizeContactPhone(
	value: string,
	options: ContactPhoneNormalizationOptions = {},
): string | null {
	const raw = value.trim();
	if (!raw || raw.length > 80 || !PHONE_PRESENTATION_CHARS.test(raw)) {
		return null;
	}

	let international = raw;
	if (international.startsWith("00")) {
		international = `+${international.slice(2)}`;
	} else if (!international.startsWith("+")) {
		if (!options.allowBareInternational || !/^\d+$/.test(international)) {
			return null;
		}
		international = `+${international}`;
	}

	// A parenthesized national trunk prefix is presentation syntax used with an
	// international number (for example +44 (0) 20...). It is not part of E.164.
	international = international.replace(/\(\s*0\s*\)/g, "");
	const parsed = parsePhoneNumberFromString(international);
	if (!parsed || parsed.ext || !parsed.isPossible()) return null;
	return parsed.number;
}

export function isContactPhone(
	value: string,
	options: ContactPhoneNormalizationOptions = {},
): boolean {
	return normalizeContactPhone(value, options) !== null;
}
