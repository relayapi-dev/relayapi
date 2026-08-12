const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
const MAX_NPM_PACKAGE_NAME_LENGTH = 214;
const NPM_PACKAGE_SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/;

function invalidPackageName(name: string): Error {
	return new Error(`Invalid npm package name: ${JSON.stringify(name)}`);
}

/** Build a registry URL with the complete package name as one encoded segment. */
export function npmRegistryPackageUrl(name: string): string {
	if (name.length === 0 || name.length > MAX_NPM_PACKAGE_NAME_LENGTH) {
		throw invalidPackageName(name);
	}

	if (name.startsWith("@")) {
		const separator = name.indexOf("/");
		if (
			separator <= 1 ||
			separator !== name.lastIndexOf("/") ||
			!NPM_PACKAGE_SEGMENT.test(name.slice(1, separator)) ||
			!NPM_PACKAGE_SEGMENT.test(name.slice(separator + 1))
		) {
			throw invalidPackageName(name);
		}
	} else if (name.includes("/") || !NPM_PACKAGE_SEGMENT.test(name)) {
		throw invalidPackageName(name);
	}

	return `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(name)}`;
}
