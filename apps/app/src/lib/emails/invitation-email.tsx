import {
	Body,
	Button,
	Container,
	Font,
	Head,
	Hr,
	Html,
	Link,
	Preview,
	Section,
	Tailwind,
	Text,
} from "@react-email/components";

interface InvitationEmailProps {
	invitedByEmail: string;
	organizationName: string;
	role: string;
	inviteUrl: string;
}

export function InvitationEmail({
	invitedByEmail,
	organizationName,
	role,
	inviteUrl,
}: InvitationEmailProps) {
	return (
		<Html>
			<Head>
				<Font
					fontFamily="Inter"
					fallbackFontFamily="Helvetica"
					webFont={{
						url: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
						format: "woff2",
					}}
					fontWeight={400}
					fontStyle="normal"
				/>
			</Head>
			<Preview>
				{invitedByEmail} invited you to join {organizationName} on RelayAPI
			</Preview>
			<Tailwind>
				<Body className="bg-gray-50 my-0 mx-auto font-sans">
					<Container className="max-w-[560px] mx-auto py-10 px-4">
						<Section className="text-center mb-8">
							<Text className="text-lg font-semibold text-gray-900 m-0">
								RelayAPI
							</Text>
						</Section>

						<Section className="bg-white rounded-lg shadow-sm px-8 py-8">
							<Text className="text-xl font-semibold text-gray-900 mb-2 text-center">
								You've been invited
							</Text>
							<Text className="text-gray-600 text-center mb-6">
								<strong>{invitedByEmail}</strong> invited you to
								join <strong>{organizationName}</strong> as a{" "}
								<strong>{role}</strong> on RelayAPI.
							</Text>

							<Section className="text-center mb-6">
								<Button
									href={inviteUrl}
									className="bg-gray-900 text-white px-8 py-3.5 rounded-lg font-semibold text-base"
								>
									Accept Invitation
								</Button>
							</Section>

							<Text className="text-sm text-gray-400 text-center m-0">
								This invitation will expire in 48 hours.
							</Text>
						</Section>

						<Section className="text-center mt-8">
							<Hr className="border-gray-200 mb-4" />
							<Text className="text-xs text-gray-400 m-0">
								&copy; {new Date().getFullYear()} RelayAPI. All
								rights reserved.
							</Text>
							<Link
								href="https://relayapi.dev"
								className="text-xs text-gray-400 underline"
							>
								relayapi.dev
							</Link>
						</Section>
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
