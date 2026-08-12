import {
	Body,
	Button,
	Container,
	Head,
	Hr,
	Html,
	Link,
	Preview,
	Section,
	Tailwind,
	Text,
} from "@react-email/components";
import { render } from "@react-email/render";

interface ShellProps {
	preview: string;
	children: React.ReactNode;
}

function Shell({ preview, children }: ShellProps) {
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
							{children}
						</Section>
						<Section className="mt-8 text-center">
							<Hr className="mb-4 border-gray-200" />
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

export async function renderOrganizationInvitation(input: {
	invitedByEmail: string;
	organizationName: string;
	role: string;
	inviteUrl: string;
}): Promise<string> {
	return render(
		<Shell
			preview={`${input.invitedByEmail} invited you to join ${input.organizationName} on RelayAPI`}
		>
			<Text className="mb-2 text-center text-xl font-semibold text-gray-900">
				You&apos;ve been invited
			</Text>
			<Text className="mb-6 text-center text-gray-600">
				<strong>{input.invitedByEmail}</strong> invited you to join{" "}
				<strong>{input.organizationName}</strong> as a{" "}
				<strong>{input.role}</strong> on RelayAPI.
			</Text>
			<Section className="mb-6 text-center">
				<Button
					href={input.inviteUrl}
					className="rounded-lg bg-gray-900 px-8 py-3.5 text-base font-semibold text-white"
				>
					Accept invitation
				</Button>
			</Section>
			<Text className="m-0 text-center text-sm text-gray-400">
				This invitation expires at the time shown on the invitation page.
			</Text>
		</Shell>,
	);
}

export async function renderAccountAction(input: {
	preview: string;
	title: string;
	message: string;
	actionLabel: string;
	actionUrl: string;
	expiresIn: string;
}): Promise<string> {
	return render(
		<Shell preview={input.preview}>
			<Text className="mb-2 text-center text-xl font-semibold text-gray-900">
				{input.title}
			</Text>
			<Text className="mb-6 text-center text-gray-600">{input.message}</Text>
			<Section className="mb-6 text-center">
				<Button
					href={input.actionUrl}
					className="rounded-lg bg-gray-900 px-8 py-3.5 text-base font-semibold text-white"
				>
					{input.actionLabel}
				</Button>
			</Section>
			<Text className="m-0 text-center text-sm text-gray-400">
				This link expires in {input.expiresIn}. If you did not request this, you
				can ignore this email.
			</Text>
		</Shell>,
	);
}

export async function renderOnDemandPlatformRequest(input: {
	platform: string;
	name?: string;
	email: string;
	message?: string;
	requestingUserEmail?: string;
}): Promise<string> {
	return render(
		<Shell preview={`On-demand platform request: ${input.platform}`}>
			<Text className="mb-4 text-xl font-semibold text-gray-900">
				New on-demand platform request
			</Text>
			<Text className="mb-2 text-gray-600">
				<strong>Platform:</strong> {input.platform}
			</Text>
			<Text className="mb-2 text-gray-600">
				<strong>Name:</strong> {input.name || "Not provided"}
			</Text>
			<Text className="mb-2 text-gray-600">
				<strong>Contact email:</strong> {input.email}
			</Text>
			<Text className="mb-2 whitespace-pre-wrap text-gray-600">
				<strong>Message:</strong> {input.message || "No message"}
			</Text>
			{input.requestingUserEmail ? (
				<Text className="mt-6 text-xs text-gray-400">
					Authenticated requester: {input.requestingUserEmail}
				</Text>
			) : null}
		</Shell>,
	);
}
