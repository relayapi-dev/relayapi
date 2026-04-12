import { Button, Section, Text } from "@react-email/components";
import { BaseLayout } from "../components/BaseLayout";

interface StreakBrokenNotificationProps {
	brokenStreakDays: number;
	bestStreakDays: number;
	dashboardUrl: string;
}

export function StreakBrokenNotification({
	brokenStreakDays,
	bestStreakDays,
	dashboardUrl,
}: StreakBrokenNotificationProps) {
	return (
		<BaseLayout
			preview={`Your ${brokenStreakDays}-day posting streak has ended`}
		>
			<Text className="text-xl font-semibold text-gray-900 mb-4">
				Your posting streak ended
			</Text>
			<Text className="text-gray-600 mb-4">
				Your <strong>{brokenStreakDays}-day</strong> posting streak
				has come to an end. No post was published within the 24-hour
				window.
			</Text>
			{bestStreakDays > 0 && (
				<Text className="text-gray-600 mb-4">
					Your best streak so far:{" "}
					<strong>{bestStreakDays} days</strong>. Can you beat it?
				</Text>
			)}
			<Text className="text-gray-600 mb-6">
				Start a new streak today by publishing a post!
			</Text>
			<Section className="text-center mb-6">
				<Button
					href={dashboardUrl}
					className="bg-indigo-600 text-white px-6 py-3 rounded-md font-medium"
				>
					Start a New Streak
				</Button>
			</Section>
		</BaseLayout>
	);
}
