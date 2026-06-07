// Ice Breaker binding tab — Plan 3 Unit C3, Task T5.
//
// WhatsApp-only. Stubbed for v1 — storage + UI ships here, platform push via
// the WhatsApp Business API lands in v1.1 (see spec §6.4).
//
// Thin wrapper over the shared binding-editors registry + StubbedBindingShell.
// The question editor, config parsing, and copy now live in ./binding-editors.

import { BINDING_CONFIG_EDITORS } from "./binding-editors";
import { StubbedBindingShell } from "./stubbed-shell";

interface Props {
	socialAccountId: string;
}

const ED = BINDING_CONFIG_EDITORS.ice_breaker;

export function IceBreakerTab({ socialAccountId }: Props) {
	return (
		<StubbedBindingShell
			socialAccountId={socialAccountId}
			channel="whatsapp"
			bindingType="ice_breaker"
			title={ED.title}
			subtitle={ED.subtitle}
			bannerCopy={ED.bannerCopy ?? ""}
			emptyConfig={ED.emptyConfig}
			parseConfig={ED.parseConfig}
			validateConfig={ED.validateConfig}
			renderEditor={ED.renderEditor!}
		/>
	);
}
