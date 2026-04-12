import { Button, Section, Text } from "@react-email/components";
import { BaseLayout } from "../components/BaseLayout";

interface PostFailedNotificationProps {
	platforms: string[];
	postId: string;
	errorSummary: string;
	dashboardUrl: string;
}

export function PostFailedNotification({
	platforms,
	postId,
	errorSummary,
	dashboardUrl,
}: PostFailedNotificationProps) {
	const platformList = platforms.length > 0 ? platforms.join(", ") : "your connected accounts";

	return (
		<BaseLayout preview={`Your post failed to publish on ${platformList}`}>
			<Text className="text-xl font-semibold text-gray-900 mb-4">
				Post Failed to Publish
			</Text>
			<Text className="text-gray-600 mb-4">
				Your post failed to publish on <strong>{platformList}</strong>.
			</Text>
			<Text className="text-gray-600 mb-6">
				{errorSummary}
			</Text>
			<Section className="text-center mb-6">
				<Button
					href={dashboardUrl}
					className="bg-rose-600 text-white px-6 py-3 rounded-md font-medium"
				>
					View Post
				</Button>
			</Section>
			<Text className="text-sm text-gray-400">
				Post ID: {postId}
			</Text>
		</BaseLayout>
	);
}
