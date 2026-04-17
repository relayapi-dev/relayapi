let openapiSpec: Record<string, unknown> | null = null;

async function getSpec(): Promise<Record<string, unknown>> {
	if (openapiSpec) return openapiSpec;
	const res = await fetch("https://api.relayapi.dev/openapi.json");
	openapiSpec = (await res.json()) as Record<string, unknown>;
	return openapiSpec;
}

interface OperationMatch {
	path: string;
	method: string;
	operation: Record<string, unknown>;
}

export async function findOperationByTitle(
	title: string,
): Promise<OperationMatch | null> {
	const spec = await getSpec();
	const paths = (spec.paths || {}) as Record<
		string,
		Record<string, Record<string, unknown>>
	>;
	for (const [path, methods] of Object.entries(paths)) {
		for (const [method, operation] of Object.entries(methods)) {
			if (operation?.summary === title) {
				return { path, method: method.toUpperCase(), operation };
			}
		}
	}
	return null;
}

export function formatSchema(
	schema: Record<string, unknown>,
	lines: string[],
	depth: number,
): void {
	if (!schema?.properties) {
		if (schema?.type === "array" && schema.items) {
			const items = schema.items as Record<string, unknown>;
			lines.push(`${"  ".repeat(depth)}Array of:`);
			if (items.properties) {
				formatSchema(items, lines, depth + 1);
			} else {
				const type = (items.type as string) || "any";
				lines.push(`${"  ".repeat(depth + 1)}- (${type})`);
			}
		}
		return;
	}

	const required = (schema.required || []) as string[];
	const properties = schema.properties as Record<
		string,
		Record<string, unknown>
	>;

	for (const [name, prop] of Object.entries(properties)) {
		const isRequired = required.includes(name) ? " **(required)**" : "";
		const nullable = prop.nullable ? ", nullable" : "";
		let type = (prop.type as string) || (prop.enum ? "enum" : "object");
		if (type === "array") {
			const itemType = (prop.items as Record<string, unknown>)?.type as
				| string
				| undefined;
			type = itemType ? `${itemType}[]` : "array";
		}
		const desc = (prop.description as string) || "";
		const indent = "  ".repeat(depth);
		const defaultVal =
			prop.default !== undefined ? ` (default: \`${prop.default}\`)` : "";
		const example =
			prop.example !== undefined ? ` (example: \`${prop.example}\`)` : "";
		const format = prop.format ? ` [${prop.format}]` : "";

		lines.push(
			`${indent}- \`${name}\` (${type}${nullable})${isRequired}: ${desc}${defaultVal}${example}${format}`,
		);

		if (prop.enum) {
			lines.push(
				`${indent}  Values: ${(prop.enum as string[]).map((v) => `\`${v}\``).join(", ")}`,
			);
		}

		if (prop.properties) {
			formatSchema(prop as Record<string, unknown>, lines, depth + 1);
		}

		if ((prop.items as Record<string, unknown>)?.properties) {
			formatSchema(
				prop.items as Record<string, unknown>,
				lines,
				depth + 1,
			);
		}

		if (
			prop.additionalProperties &&
			typeof prop.additionalProperties === "object" &&
			(prop.additionalProperties as Record<string, unknown>).properties
		) {
			formatSchema(
				prop.additionalProperties as Record<string, unknown>,
				lines,
				depth + 1,
			);
		}
	}
}

function generateSchemaExample(schema: Record<string, unknown>): unknown {
	if (schema.example !== undefined) return schema.example;

	if (schema.type === "array") {
		const items = schema.items as Record<string, unknown> | undefined;
		return items ? [generateSchemaExample(items)] : [];
	}

	if (schema.type !== "object" && !schema.properties) {
		if (schema.enum) return (schema.enum as unknown[])[0];
		switch (schema.type) {
			case "string":
				return schema.format === "uri" ? "https://example.com" : "string";
			case "number":
			case "integer":
				return 0;
			case "boolean":
				return true;
			default:
				return "string";
		}
	}

	const obj: Record<string, unknown> = {};
	const properties = (schema.properties || {}) as Record<
		string,
		Record<string, unknown>
	>;
	const required = (schema.required || []) as string[];

	for (const [name, prop] of Object.entries(properties)) {
		if (required.includes(name) || Object.keys(properties).length <= 6) {
			obj[name] = generateSchemaExample(prop);
		}
	}
	return obj;
}

function generateCurlExample(
	op: OperationMatch,
	requestBody?: Record<string, unknown> | undefined,
): string {
	const parts: string[] = [];
	parts.push(`curl -X ${op.method} "https://api.relayapi.dev${op.path}"`);
	parts.push(`  -H "Authorization: Bearer <your-api-key>"`);

	if (requestBody) {
		parts.push(`  -H "Content-Type: application/json"`);
		const content = (
			requestBody.content as Record<string, Record<string, unknown>>
		)?.["application/json"];
		if (content?.schema) {
			const example = generateSchemaExample(
				content.schema as Record<string, unknown>,
			);
			parts.push(
				`  -d '${JSON.stringify(example, null, 2).split("\n").join("\n  ")}'`,
			);
		}
	}

	return parts.join(" \\\n");
}

export async function generateApiPageContent(page: {
	data: { title: string; description?: string };
	url: string;
}): Promise<string> {
	const lines: string[] = [];
	const op = await findOperationByTitle(page.data.title);

	if (op) {
		lines.push(`\`${op.method} https://api.relayapi.dev${op.path}\``);
		lines.push("");
	}

	if (page.data.description) {
		lines.push(page.data.description);
		lines.push("");
	}

	lines.push(`Documentation: https://docs.relayapi.dev${page.url}`);
	lines.push("");

	if (!op) return lines.join("\n");

	const { operation } = op;

	// Authentication
	const security = operation.security as
		| Array<Record<string, unknown>>
		| undefined;
	if (security?.length) {
		lines.push("## Authentication\n");
		lines.push("Bearer token required in `Authorization` header.");
		lines.push("");
		lines.push("```");
		lines.push("Authorization: Bearer <your-api-key>");
		lines.push("```");
		lines.push("");
	}

	// Parameters
	const params = operation.parameters as
		| Array<Record<string, unknown>>
		| undefined;
	if (params?.length) {
		lines.push("## Parameters\n");
		for (const param of params) {
			const required = param.required ? " **(required)**" : "";
			const schema = param.schema as Record<string, unknown> | undefined;
			const type = (schema?.type as string) || "";
			const desc = (param.description as string) || "";
			const location = param.in ? ` (in: ${param.in})` : "";
			lines.push(
				`- \`${param.name}\` (${type})${required}${location}: ${desc}`,
			);
			if (schema?.enum) {
				lines.push(
					`  Values: ${(schema.enum as string[]).map((v) => `\`${v}\``).join(", ")}`,
				);
			}
			if (schema?.default !== undefined) {
				lines.push(`  Default: \`${schema.default}\``);
			}
		}
		lines.push("");
	}

	// Request body
	const requestBody = operation.requestBody as
		| Record<string, unknown>
		| undefined;
	if (requestBody) {
		lines.push("## Request Body\n");
		const contentTypes = requestBody.content as
			| Record<string, Record<string, unknown>>
			| undefined;
		if (contentTypes) {
			for (const [contentType, media] of Object.entries(contentTypes)) {
				lines.push(`Content-Type: \`${contentType}\`\n`);
				if (media?.schema) {
					formatSchema(
						media.schema as Record<string, unknown>,
						lines,
						0,
					);
				}
			}
		}
		lines.push("");
	}

	// Responses
	const responses = operation.responses as
		| Record<string, Record<string, unknown>>
		| undefined;
	if (responses) {
		lines.push("## Responses\n");
		for (const [code, response] of Object.entries(responses)) {
			lines.push(
				`### ${code}: ${(response.description as string) || ""}\n`,
			);
			const content = (
				response.content as Record<string, Record<string, unknown>>
			)?.["application/json"];
			if (content?.schema) {
				formatSchema(
					content.schema as Record<string, unknown>,
					lines,
					0,
				);
			}
			lines.push("");
		}
	}

	// Example curl
	lines.push("## Example\n");
	lines.push("```bash");
	lines.push(generateCurlExample(op, requestBody));
	lines.push("```");
	lines.push("");

	return lines.join("\n");
}

export async function generateLLMText(
	title: string,
	description: string | undefined,
	url: string,
	isApiPage: boolean,
	content?: string,
): Promise<string> {
	const fullUrl = `https://docs.relayapi.dev${url}`;
	const lines: string[] = [];

	lines.push(`# ${title}`);
	lines.push("");

	if (isApiPage) {
		const apiContent = await generateApiPageContent({
			data: { title, description },
			url,
		});
		lines.push(apiContent);
	} else {
		if (description) {
			lines.push(description);
			lines.push("");
		}

		lines.push(`Documentation: ${fullUrl}`);
		lines.push("");

		if (content) {
			lines.push(content);
		}
	}

	return lines.join("\n").trim();
}

export function generateLLMIndex(
	pages: Array<{ title: string; description?: string; url: string }>,
): string {
	const lines: string[] = [];
	lines.push("# RelayAPI Documentation\n");
	lines.push(
		"> Unified social media API for posting to 21 platforms via a single API.\n",
	);
	lines.push("- Documentation: https://docs.relayapi.dev");
	lines.push(
		"- Full docs for LLMs: https://docs.relayapi.dev/llms-full.txt\n",
	);
	lines.push("## Pages\n");

	for (const page of pages) {
		lines.push(
			`- [${page.title}](https://docs.relayapi.dev${page.url}): ${page.description || ""}`,
		);
	}

	return lines.join("\n");
}
