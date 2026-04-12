import { Button, Section, Text } from "@react-email/components";
import { BaseLayout } from "../components/BaseLayout";

interface WeeklyDigestNotificationProps {
	postsPublished: number;
	postsFailed: number;
	totalImpressions: number;
	dashboardUrl: string;
}

export function WeeklyDigestNotification({
	postsPublished,
	postsFailed,
	totalImpressions,
	dashboardUrl,
}: WeeklyDigestNotificationProps) {
	return (
		<BaseLayout preview="Your weekly RelayAPI summary">
			<Text className="text-xl font-semibold text-gray-900 mb-4">
				Your Weekly Summary
			</Text>
			<Text className="text-gray-600 mb-6">
				Here&apos;s a summary of your publishing activity this week:
			</Text>
			<Section className="mb-6">
				<table
					style={{ width: "100%", borderCollapse: "collapse" }}
				>
					<tbody>
						<tr>
							<td style={{ padding: "12px 0", borderBottom: "1px solid #e5e7eb" }}>
								<Text className="text-sm text-gray-500 m-0">
									Posts Published
								</Text>
							</td>
							<td style={{ padding: "12px 0", borderBottom: "1px solid #e5e7eb", textAlign: "right" }}>
								<Text className="text-sm font-semibold text-gray-900 m-0">
									{postsPublished}
								</Text>
							</td>
						</tr>
						<tr>
							<td style={{ padding: "12px 0", borderBottom: "1px solid #e5e7eb" }}>
								<Text className="text-sm text-gray-500 m-0">
									Posts Failed
								</Text>
							</td>
							<td style={{ padding: "12px 0", borderBottom: "1px solid #e5e7eb", textAlign: "right" }}>
								<Text className="text-sm font-semibold text-gray-900 m-0">
									{postsFailed}
								</Text>
							</td>
						</tr>
						<tr>
							<td style={{ padding: "12px 0" }}>
								<Text className="text-sm text-gray-500 m-0">
									Total Impressions
								</Text>
							</td>
							<td style={{ padding: "12px 0", textAlign: "right" }}>
								<Text className="text-sm font-semibold text-gray-900 m-0">
									{totalImpressions.toLocaleString()}
								</Text>
							</td>
						</tr>
					</tbody>
				</table>
			</Section>
			<Section className="text-center mb-6">
				<Button
					href={dashboardUrl}
					className="bg-indigo-600 text-white px-6 py-3 rounded-md font-medium"
				>
					View Analytics
				</Button>
			</Section>
		</BaseLayout>
	);
}
