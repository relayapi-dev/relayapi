// Data for the Cursor-style marketing landing page.
// Transcribed verbatim from the approved mockup
// ("RelayAPI Landing.dc.html" → renderVals()). Copy is intentionally
// kept as-is (playful placeholder testimonials).

/** Brand-icon SVG path data (single `<path d>` per platform). */
export const PLATFORM_PATHS = {
	instagram:
		"M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163C8.741 0 8.332.014 7.052.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z",
	linkedin:
		"M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
	tiktok:
		"M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z",
	facebook:
		"M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z",
	x: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
	youtube:
		"M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
	threads:
		"M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.781 3.631 2.695 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.331-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.74-1.756-.503-.582-1.279-.876-2.309-.883h-.029c-.825 0-1.951.231-2.674 1.32L7.514 7.117c.99-1.519 2.578-2.347 4.572-2.347h.045c3.397.022 5.426 2.124 5.563 5.674.087.05.173.1.258.151 1.222.731 2.121 1.834 2.598 3.19.665 1.889.704 4.969-1.804 7.421-1.917 1.877-4.245 2.71-7.563 2.734Z",
	pinterest:
		"M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z",
	reddit:
		"M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z",
	bluesky:
		"M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026",
	mastodon:
		"M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z",
	telegram:
		"M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z",
	whatsapp:
		"M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z",
	snapchat:
		"M12.206.793c.99 0 4.347.276 5.93 3.821.529 1.193.403 3.219.299 4.847l-.003.06c-.012.18-.022.345-.03.51.075.045.203.09.401.09.3-.016.659-.12 1.033-.301.165-.088.344-.104.464-.104.182 0 .359.029.509.09.45.149.734.479.734.838.015.449-.39.839-1.213 1.168-.089.029-.209.075-.344.119-.45.135-1.139.36-1.333.81-.09.224-.061.524.12.868l.015.015c.06.136 1.526 3.475 4.791 4.014.255.044.435.27.42.509 0 .075-.015.149-.045.225-.24.569-1.273.988-3.146 1.271-.059.091-.12.375-.164.57-.029.179-.074.36-.134.553-.076.271-.27.405-.555.405h-.03c-.135 0-.313-.031-.538-.074-.36-.075-.765-.135-1.273-.135-.3 0-.599.015-.913.074-.6.104-1.123.464-1.723.884-.853.599-1.826 1.288-3.294 1.288-.06 0-.119-.015-.18-.015h-.149c-1.468 0-2.427-.675-3.279-1.288-.599-.42-1.107-.779-1.707-.884-.314-.045-.629-.074-.928-.074-.54 0-.958.089-1.272.149-.211.043-.391.074-.54.074-.374 0-.523-.224-.583-.42-.061-.192-.09-.389-.135-.567-.046-.181-.105-.494-.166-.57-1.918-.222-2.95-.642-3.189-1.226-.031-.063-.052-.15-.055-.225-.015-.243.165-.465.42-.509 3.264-.54 4.73-3.879 4.791-4.02l.016-.029c.18-.345.224-.645.119-.869-.195-.434-.884-.658-1.332-.809-.121-.029-.24-.074-.346-.119-1.107-.435-1.257-.93-1.197-1.273.09-.479.674-.793 1.168-.793.146 0 .27.029.383.074.42.194.789.3 1.104.3.234 0 .384-.06.465-.105l-.046-.569c-.098-1.626-.225-3.651.307-4.837C7.392 1.077 10.739.807 11.727.807l.419-.015h.06z",
	discord:
		"M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
	google:
		"M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z",
} as const;

export interface HeroChannel {
	/** Display name (used for tooltip / aria-label). */
	name: string;
	/** Short text fallback when no brand glyph is available. */
	initial: string;
	/** Single-path simple-icons glyph, rendered monochrome via currentColor. */
	glyph?: string;
}

/**
 * The channels shown fanning out in the animated hero dashboard.
 * "Channels" = connected accounts, so a few platforms appear more than once
 * (a Page, a second profile…) — this is how the real product works and lets
 * the cascade land on an honest "21 / 21". Ordered so duplicate glyphs never
 * sit adjacent in the 7-column grid.
 */
export const heroChannels: HeroChannel[] = [
	{ name: "X", initial: "X", glyph: PLATFORM_PATHS.x },
	{ name: "Instagram", initial: "IG", glyph: PLATFORM_PATHS.instagram },
	{ name: "LinkedIn", initial: "in", glyph: PLATFORM_PATHS.linkedin },
	{ name: "Facebook", initial: "f", glyph: PLATFORM_PATHS.facebook },
	{ name: "YouTube", initial: "YT", glyph: PLATFORM_PATHS.youtube },
	{ name: "TikTok", initial: "TT", glyph: PLATFORM_PATHS.tiktok },
	{ name: "Threads", initial: "T", glyph: PLATFORM_PATHS.threads },
	{ name: "Pinterest", initial: "P", glyph: PLATFORM_PATHS.pinterest },
	{ name: "Reddit", initial: "R", glyph: PLATFORM_PATHS.reddit },
	{ name: "Bluesky", initial: "BS", glyph: PLATFORM_PATHS.bluesky },
	{ name: "Mastodon", initial: "M", glyph: PLATFORM_PATHS.mastodon },
	{ name: "Telegram", initial: "TG", glyph: PLATFORM_PATHS.telegram },
	{ name: "WhatsApp", initial: "WA", glyph: PLATFORM_PATHS.whatsapp },
	{ name: "Snapchat", initial: "S", glyph: PLATFORM_PATHS.snapchat },
	{ name: "Discord", initial: "D", glyph: PLATFORM_PATHS.discord },
	{ name: "Google Business", initial: "G", glyph: PLATFORM_PATHS.google },
	{ name: "Instagram · Reels", initial: "IG", glyph: PLATFORM_PATHS.instagram },
	{ name: "Facebook · Page", initial: "f", glyph: PLATFORM_PATHS.facebook },
	{ name: "YouTube · Shorts", initial: "YT", glyph: PLATFORM_PATHS.youtube },
	{ name: "LinkedIn · Company", initial: "in", glyph: PLATFORM_PATHS.linkedin },
	{ name: "SMS", initial: "SM" },
];

export interface ReviewTask {
	title: string;
	time: string;
	sub: string;
}

export const reviewTasks: ReviewTask[] = [
	{ title: "Launch announcement", time: "now", sub: "Done. Delivered to 21 platforms." },
	{ title: "Weekly product digest", time: "now", sub: "All set! Scheduled for Monday 9 AM." },
	{ title: "Reply to top mentions", time: "now", sub: "+12 · Drafted replies for review" },
	{ title: "Instagram Reel · v2", time: "10m", sub: "Reformatted media for Reels + TikTok" },
	{ title: "Set up auto-repost rule", time: "30m", sub: "Auto-repost Blog posts to LinkedIn" },
	{ title: "Quarterly recap thread", time: "45m", sub: "Drafted 6-post thread for X" },
];

export interface PlatformLogo {
	/** Display name shown next to the brand glyph. */
	name: string;
	/** Single-path simple-icons glyph, rendered monochrome via currentColor. */
	glyph: string;
}

/**
 * The platforms RelayAPI publishes to — rendered as a slow logo marquee in the
 * trust strip. Real brand glyphs (not customer logos), so the wall honestly
 * reads as "every platform you publish to" rather than implying endorsement.
 */
export const platformLogos: PlatformLogo[] = [
	{ name: "X", glyph: PLATFORM_PATHS.x },
	{ name: "Instagram", glyph: PLATFORM_PATHS.instagram },
	{ name: "LinkedIn", glyph: PLATFORM_PATHS.linkedin },
	{ name: "Facebook", glyph: PLATFORM_PATHS.facebook },
	{ name: "YouTube", glyph: PLATFORM_PATHS.youtube },
	{ name: "TikTok", glyph: PLATFORM_PATHS.tiktok },
	{ name: "Threads", glyph: PLATFORM_PATHS.threads },
	{ name: "Pinterest", glyph: PLATFORM_PATHS.pinterest },
	{ name: "Reddit", glyph: PLATFORM_PATHS.reddit },
	{ name: "Bluesky", glyph: PLATFORM_PATHS.bluesky },
	{ name: "Mastodon", glyph: PLATFORM_PATHS.mastodon },
	{ name: "Telegram", glyph: PLATFORM_PATHS.telegram },
	{ name: "WhatsApp", glyph: PLATFORM_PATHS.whatsapp },
	{ name: "Snapchat", glyph: PLATFORM_PATHS.snapchat },
	{ name: "Discord", glyph: PLATFORM_PATHS.discord },
	{ name: "Google Business", glyph: PLATFORM_PATHS.google },
];

export interface ScheduleRow {
	name: string;
	path: string;
	status: string;
	color: string;
}

export const scheduleRows: ScheduleRow[] = [
	{ name: "Twitter / X", path: PLATFORM_PATHS.x, status: "delivered", color: "#7FB88A" },
	{ name: "LinkedIn", path: PLATFORM_PATHS.linkedin, status: "delivered", color: "#7FB88A" },
	{ name: "Instagram", path: PLATFORM_PATHS.instagram, status: "publishing", color: "#D9A66B" },
	{ name: "TikTok", path: PLATFORM_PATHS.tiktok, status: "queued · 12:00", color: "#8C887E" },
	{ name: "YouTube", path: PLATFORM_PATHS.youtube, status: "queued · 14:00", color: "#8C887E" },
];

export interface Testimonial {
	quote: string;
	name: string;
	role: string;
	avatarBg: string;
	initial: string;
}

export const testimonials: Testimonial[] = [
	{
		quote:
			"I used to mass-communicate through parables and word of mouth. With Relay, I can post to all 21 platforms at once. Truly a miracle.",
		name: "Jesus Christ",
		role: "Son of God at Heaven Inc.",
		avatarBg: "#E4D8C2",
	},
	{
		quote:
			"I don't use APIs. APIs use me. But I made an exception for Relay because it's the only API that doesn't flinch when I send a request.",
		name: "Chuck Norris",
		role: "Chief Roundhouse Officer, Fists of Fury LLC",
		avatarBg: "#D2BC9A",
	},
	{
		quote:
			"I find your lack of cross-platform posting disturbing. Relay brought order to our galactic social media chaos.",
		name: "Darth Vader",
		role: "Dark Lord of the Sith, The Galactic Empire",
		avatarBg: "#CCC2AD",
	},
	{
		quote:
			"A wizard never mistimes a social post, nor sends it too early. He posts precisely when he means to. With Relay, of course.",
		name: "Gandalf",
		role: "Senior Wizard, Middle Earth Solutions",
		avatarBg: "#DED7C7",
	},
	{
		quote:
			"Social media is like onions — it has layers. Relay handles all the layers for me so I can get back to me swamp.",
		name: "Shrek",
		role: "CEO, Swamp Enterprises",
		avatarBg: "#C8A883",
	},
	{
		quote:
			"I work alone. But even I needed help posting across platforms. Relay is the Robin I actually wanted. Silent, efficient, no cape.",
		name: "Batman",
		role: "Vigilante & CTO, Wayne Enterprises",
		avatarBg: "#E2D2BA",
	},
].map((t) => ({ ...t, initial: t.name.charAt(0) }));

export interface FrontierCard {
	title: string;
	body: string;
	link: string;
	bg: string;
	icon: string;
}

export const frontier: FrontierCard[] = [
	{
		title: "Every platform, one API",
		body: "Consistent request format, unified error handling, and standardized responses across all 21 networks.",
		link: "Explore platforms",
		bg: "linear-gradient(160deg,#E4D8C2,#D2BC9A)",
		icon: "M5 12h14M12 5v14",
	},
	{
		title: "Complete media understanding",
		body: "Upload once — images and video get auto-resized and reformatted to each platform's exact specs.",
		link: "Media API docs",
		bg: "linear-gradient(160deg,#DED7C7,#CCC2AD)",
		icon: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z",
	},
	{
		title: "Build enduring integrations",
		body: "Webhooks, analytics, and SDKs for TypeScript, Python, Go, and Java. Drop it into any stack.",
		link: "Read the docs",
		bg: "linear-gradient(160deg,#E2D2BA,#C8A883)",
		icon: "M16 18l6-6-6-6M8 6l-6 6 6 6",
	},
];

export interface CompareRow {
	name: string;
	c50: string;
	c500: string;
	color: string;
}

export const compareRows: CompareRow[] = [
	{ name: "RelayAPI", c50: "$10/mo", c500: "$145/mo", color: "#1A1815" },
	{ name: "Per-account API", c50: "$779/mo", c500: "$2,624/mo", color: "#9A968C" },
	{ name: "Usage-based API", c50: "$275/mo", c500: "$2,750/mo", color: "#9A968C" },
];

export interface ChangelogEntry {
	date: string;
	title: string;
}

export const changelog: ChangelogEntry[] = [
	{ date: "Jun 10, 2026", title: "Bluesky and Threads now support native video uploads" },
	{ date: "Jun 4, 2026", title: "Custom webhooks, retry policies, and per-platform scheduling" },
	{ date: "May 28, 2026", title: "Analytics API v2 — cross-platform engagement in one call" },
	{ date: "May 14, 2026", title: "New Go and Java SDKs, plus a faster media pipeline" },
];

export interface BlogPost {
	tag: string;
	title: string;
	meta: string;
	bg: string;
}

export const blog: BlogPost[] = [
	{
		tag: "Product",
		title: "Introducing RelayAPI v2",
		meta: "Relay Team · 7 min read",
		bg: "linear-gradient(160deg,#E4D8C2,#D2BC9A)",
	},
	{
		tag: "Engineering",
		title: "Delivering to 21 platforms in under 100ms",
		meta: "Giulio Z. · 5 min read",
		bg: "linear-gradient(160deg,#DED7C7,#CCC2AD)",
	},
	{
		tag: "Guides",
		title: "Posting from Claude with the OpenClaw skill",
		meta: "Relay Team · 4 min read",
		bg: "linear-gradient(160deg,#E2D2BA,#C8A883)",
	},
	{
		tag: "Research",
		title: "The hidden cost of per-account social APIs",
		meta: "Relay Team · 6 min read",
		bg: "linear-gradient(160deg,#E6DCC8,#D6C8AE)",
	},
];

export interface FooterColumn {
	title: string;
	links: string[];
}

export const footerCols: FooterColumn[] = [
	{ title: "Product", links: ["Posting API", "Media API", "Analytics API", "Webhooks API", "Pricing"] },
	{ title: "Platforms", links: ["Instagram", "X / Twitter", "LinkedIn", "TikTok", "All platforms"] },
	{ title: "Resources", links: ["Documentation", "API Reference", "Changelog", "Login", "Sign up"] },
	{ title: "Legal", links: ["Privacy Policy", "Terms of Service"] },
];

/** Shared external/internal link targets for the landing. */
export const LANDING_LINKS = {
	signup: "/signup",
	login: "/login",
	pricing: "/pricing",
	docs: "https://docs.relayapi.dev",
	quickstart: "https://docs.relayapi.dev/quickstart",
	changelog: "https://docs.relayapi.dev/changelog",
	github: "https://github.com/relayapi-dev/relayapi",
} as const;
