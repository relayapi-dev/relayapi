import {
	Body,
	Button,
	Container,
	Head,
	Html,
	Preview,
	Section,
	Tailwind,
	Text,
} from "@react-email/components";

interface AccountActionEmailProps {
	preview: string;
	title: string;
	message: string;
	actionLabel: string;
	actionUrl: string;
	expiresIn: string;
}

export function AccountActionEmail({
	preview,
	title,
	message,
	actionLabel,
	actionUrl,
	expiresIn,
}: AccountActionEmailProps) {
	return (
		<Html>
			<Head />
			<Preview>{preview}</Preview>
			<Tailwind>
				<Body className="mx-auto my-0 bg-gray-50 font-sans">
					<Container className="mx-auto max-w-[560px] px-4 py-10">
						<Section className="mb-8 text-center">
							<Text className="m-0 text-lg font-semibold text-gray-900">
								RelayAPI
							</Text>
						</Section>
						<Section className="rounded-lg bg-white px-8 py-8 shadow-sm">
							<Text className="mb-2 text-center text-xl font-semibold text-gray-900">
								{title}
							</Text>
							<Text className="mb-6 text-center text-gray-600">{message}</Text>
							<Section className="mb-6 text-center">
								<Button
									href={actionUrl}
									className="rounded-lg bg-gray-900 px-8 py-3.5 text-base font-semibold text-white"
								>
									{actionLabel}
								</Button>
							</Section>
							<Text className="m-0 text-center text-sm text-gray-400">
								This link expires in {expiresIn}. If you did not request this,
								you can ignore this email.
							</Text>
						</Section>
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
