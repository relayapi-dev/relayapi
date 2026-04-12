import { createAccessControl } from "better-auth/plugins/access";

const statement = {
	organization: ["update", "delete"],
	member: ["create", "update", "delete"],
	invitation: ["create", "cancel"],
} as const;

export const ac = createAccessControl(statement);

export const ownerRole = ac.newRole({
	organization: ["update"],
	member: ["create", "update", "delete"],
	invitation: ["create", "cancel"],
});

export const adminRole = ac.newRole({
	organization: ["update"],
	member: ["create", "update", "delete"],
	invitation: ["create", "cancel"],
});

export const memberRole = ac.newRole({
	invitation: [],
});

export const roles = {
	owner: ownerRole,
	admin: adminRole,
	member: memberRole,
};
