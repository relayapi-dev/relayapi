import { Button, Section, Text } from "@react-email/components";
import { BaseLayout } from "../components/BaseLayout";

interface PostPublishedNotificationProps {
	platforms: string[];
	postId: string;
	dashboardUrl: string;
}

export function PostPublishedNotification({
	platforms,
	postId,
	dashboardUrl,
}: PostPublishedNotificationProps) {
	const platformList = platforms.length > 0 ? platforms.join(", ") : "your connected accounts";

	return (
		<BaseLayout preview={`Your post was published to ${platformList}`}>
			<Text className="text-xl font-semibold text-gray-900 mb-4">
				Post Published Successfully
			</Text>
			<Text className="text-gray-600 mb-6">
				Your post was published to <strong>{platformList}</strong>.
			</Text>
			<Section className="text-center mb-6">
				<Button
					href={dashboardUrl}
					className="bg-emerald-600 text-white px-6 py-3 rounded-md font-medium"
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
