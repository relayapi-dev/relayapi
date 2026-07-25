type DeploymentEnv = {
	DEPLOYMENT_MODE?: string;
};

export function isSelfHostedDeployment(env: DeploymentEnv): boolean {
	return env.DEPLOYMENT_MODE === "self_hosted";
}

export const IS_SELF_HOSTED_BUILD =
	import.meta.env.PUBLIC_DEPLOYMENT_MODE === "self_hosted";

export const SELF_HOSTED_AI_ENABLED =
	IS_SELF_HOSTED_BUILD && import.meta.env.PUBLIC_SELF_HOSTED_FEATURE_AI === "1";
