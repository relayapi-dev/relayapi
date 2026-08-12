import { type SQL, sql } from "drizzle-orm";

/**
 * Render a source-owned PostgreSQL text literal for schema DDL.
 *
 * Drizzle treats ordinary template interpolations as bind parameters. PostgreSQL
 * does not allow those parameters in CHECK constraint DDL, so the small number
 * of source-controlled registry constants used there must be rendered inline.
 * Escape-string syntax plus escaping both backslashes and quotes keeps the raw
 * fragment a single literal regardless of the source value.
 */
export function ddlTextLiteral(value: string): SQL {
	if (value.includes("\0")) {
		throw new RangeError("PostgreSQL text literals cannot contain NUL bytes");
	}

	return sql.raw(`E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`);
}

/**
 * Render a source-owned integer literal for schema DDL.
 *
 * Rejecting every non-safe integer prevents exponential notation, fractions,
 * infinities, and rounded values from entering a raw SQL fragment.
 */
export function ddlIntegerLiteral(value: number): SQL {
	if (!Number.isSafeInteger(value)) {
		throw new RangeError(
			`DDL integer literal must be a safe integer: ${value}`,
		);
	}

	return sql.raw(String(value));
}
