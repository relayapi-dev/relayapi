import { Button, Section, Text } from "@react-email/components";
import { BaseLayout } from "../components/BaseLayout";

interface UsageWarningNotificationProps {
	percentUsed: number;
	callsUsed: number;
	callsIncluded: number;
	plan: string;
	dashboardUrl: string;
}

export function UsageWarningNotification({
	percentUsed,
	callsUsed,
	callsIncluded,
	plan,
	dashboardUrl,
}: UsageWarningNotificationProps) {
	const isAtLimit = percentUsed >= 100;

	return (
		<BaseLayout
			preview={
				isAtLimit
					? "You've reached your API call limit"
					: `You've used ${percentUsed}% of your API calls`
			}
		>
			<Text className="text-xl font-semibold text-gray-900 mb-4">
				{isAtLimit ? "API Call Limit Reached" : "Approaching Your API Call Limit"}
			</Text>
			<Text className="text-gray-600 mb-4">
				You&apos;ve used <strong>{callsUsed.toLocaleString()}</strong> of
				your <strong>{callsIncluded.toLocaleString()}</strong> included API
				calls ({percentUsed}%).
			</Text>
			{isAtLimit ? (
				<Text className="text-gray-600 mb-6">
					{plan === "free"
						? "Upgrade to Pro to continue making API calls."
						: "Additional calls will be billed at your overage rate."}
				</Text>
			) : (
				<Text className="text-gray-600 mb-6">
					{plan === "free"
						? "Consider upgrading to Pro for more API calls."
						: "You're approaching your included call limit. Additional calls will be billed at your overage rate."}
				</Text>
			)}
			<Section className="text-center mb-6">
				<Button
					href={dashboardUrl}
					className="bg-indigo-600 text-white px-6 py-3 rounded-md font-medium"
				>
					{plan === "free" ? "Upgrade to Pro" : "View Usage"}
				</Button>
			</Section>
		</BaseLayout>
	);
}
