import { Button, Link, Section, Text } from "@react-email/components";
import { BaseLayout } from "../components/BaseLayout";

interface PaymentFailedReminderProps {
	orgName: string;
	invoiceUrl: string | null;
	portalUrl: string;
	isSecondReminder: boolean;
}

export function PaymentFailedReminder({
	orgName,
	invoiceUrl,
	portalUrl,
	isSecondReminder,
}: PaymentFailedReminderProps) {
	return (
		<BaseLayout
			preview={
				isSecondReminder
					? `Action required: your RelayAPI payment is still outstanding`
					: `Your RelayAPI payment failed`
			}
		>
			<Text className="text-xl font-semibold text-gray-900 mb-4">
				Payment Failed
			</Text>
			<Text className="text-gray-600 mb-4">
				We were unable to process the payment for your{" "}
				<strong>{orgName}</strong> Pro plan.
			</Text>
			{isSecondReminder && (
				<Text className="text-gray-600 mb-4">
					This is a reminder — your plan will be deactivated if
					payment is not received within the next week.
				</Text>
			)}
			<Text className="text-gray-600 mb-6">
				Please update your payment method to avoid losing access to Pro
				features.
			</Text>
			<Section className="text-center mb-6">
				<Button
					href={portalUrl}
					className="bg-rose-600 text-white px-6 py-3 rounded-md font-medium"
				>
					Update Payment Method
				</Button>
			</Section>
			{invoiceUrl && (
				<Text className="text-sm text-gray-500">
					Or{" "}
					<Link href={invoiceUrl} className="text-rose-600 underline">
						pay the outstanding invoice directly
					</Link>
					.
				</Text>
			)}
		</BaseLayout>
	);
}
