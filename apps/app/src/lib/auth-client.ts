import { adminClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { ac, roles } from "@relayapi/auth/permissions";

export const authClient = createAuthClient({
	plugins: [
		adminClient(),
		organizationClient({
			ac,
			roles,
		}),
	],
});

export const {
	signIn,
	signOut,
	signUp,
	useSession,
	getSession,
	organization,
} = authClient;

export type Session = typeof authClient.$Infer.Session;
export type User = Session["user"];
