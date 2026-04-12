import { Button, Section, Text } from "@react-email/components";
import { BaseLayout } from "../components/BaseLayout";

interface StreakWarningNotificationProps {
	currentStreakDays: number;
	hoursRemaining: number;
	dashboardUrl: string;
}

export function StreakWarningNotification({
	currentStreakDays,
	hoursRemaining,
	dashboardUrl,
}: StreakWarningNotificationProps) {
	const hours = Math.floor(hoursRemaining);
	const minutes = Math.round((hoursRemaining - hours) * 60);
	const timeLabel =
		hours > 0 ? `${hours}h ${minutes}m` : `${minutes} minutes`;

	return (
		<BaseLayout
			preview={`Your ${currentStreakDays}-day posting streak is about to end!`}
		>
			<Text className="text-xl font-semibold text-gray-900 mb-4">
				Your posting streak is about to end!
			</Text>
			<Text className="text-gray-600 mb-4">
				You have <strong>{timeLabel}</strong> to publish a post and
				keep your <strong>{currentStreakDays}-day</strong> posting
				streak alive.
			</Text>
			<Text className="text-gray-600 mb-6">
				Don&apos;t let your streak break — create and publish a post
				now to keep the momentum going.
			</Text>
			<Section className="text-center mb-6">
				<Button
					href={dashboardUrl}
					className="bg-amber-600 text-white px-6 py-3 rounded-md font-medium"
				>
					Create a Post
				</Button>
			</Section>
		</BaseLayout>
	);
}
