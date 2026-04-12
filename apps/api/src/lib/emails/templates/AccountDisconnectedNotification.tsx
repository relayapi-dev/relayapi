import { Button, Section, Text } from "@react-email/components";
import { BaseLayout } from "../components/BaseLayout";

interface AccountDisconnectedNotificationProps {
	platform: string;
	accountName: string;
	dashboardUrl: string;
}

export function AccountDisconnectedNotification({
	platform,
	accountName,
	dashboardUrl,
}: AccountDisconnectedNotificationProps) {
	const displayName = accountName ? `${accountName} (${platform})` : platform;

	return (
		<BaseLayout preview={`Your ${platform} account was disconnected`}>
			<Text className="text-xl font-semibold text-gray-900 mb-4">
				Account Disconnected
			</Text>
			<Text className="text-gray-600 mb-4">
				Your <strong>{displayName}</strong> account has been disconnected.
				This may be due to an expired or revoked access token.
			</Text>
			<Text className="text-gray-600 mb-6">
				Reconnect the account to continue publishing to {platform}.
			</Text>
			<Section className="text-center mb-6">
				<Button
					href={dashboardUrl}
					className="bg-indigo-600 text-white px-6 py-3 rounded-md font-medium"
				>
					Reconnect Account
				</Button>
			</Section>
		</BaseLayout>
	);
}
