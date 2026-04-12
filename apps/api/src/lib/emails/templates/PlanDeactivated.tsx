import { Button, Section, Text } from "@react-email/components";
import { BaseLayout } from "../components/BaseLayout";

interface PlanDeactivatedProps {
	orgName: string;
}

export function PlanDeactivated({ orgName }: PlanDeactivatedProps) {
	return (
		<BaseLayout preview="Your RelayAPI Pro plan has been deactivated">
			<Text className="text-xl font-semibold text-gray-900 mb-4">
				Pro Plan Deactivated
			</Text>
			<Text className="text-gray-600 mb-4">
				Your <strong>{orgName}</strong> Pro plan has been deactivated due
				to an unpaid invoice. Your workspace has been downgraded to the
				Free plan (200 API calls/month).
			</Text>
			<Text className="text-gray-600 mb-6">
				You can resubscribe at any time from the Billing page in your
				dashboard.
			</Text>
			<Section className="text-center mb-2">
				<Button
					href="https://relayapi.dev/app/billing"
					className="bg-rose-600 text-white px-6 py-3 rounded-md font-medium"
				>
					Resubscribe
				</Button>
			</Section>
		</BaseLayout>
	);
}
