import { Navbar } from "../section/navbar";

export function PrivacyPage() {
	return (
		<div className="max-w-7xl mx-auto border-x border-border">
			<Navbar />
			<main className="flex flex-col divide-y divide-border pt-16">
				{/* Hero */}
				<section className="py-16 md:py-24 px-6 text-center">
					<p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
						Legal
					</p>
					<h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tighter text-foreground mt-4 text-balance">
						Privacy Policy
					</h1>
					<p className="text-lg text-muted-foreground max-w-2xl mx-auto mt-6 text-balance">
						Last updated: March 23, 2026
					</p>
				</section>

				{/* Content */}
				<section className="py-12 md:py-16 px-6">
					<div className="max-w-3xl mx-auto text-foreground [&_h2]:text-2xl [&_h2]:font-bold [&_h2]:tracking-tight [&_h2]:mt-10 [&_h2]:mb-4 [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:tracking-tight [&_h3]:mt-8 [&_h3]:mb-3 [&_p]:text-muted-foreground [&_p]:leading-7 [&_p]:mb-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-4 [&_ul]:text-muted-foreground [&_li]:mb-2 [&_li]:leading-7 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 hover:[&_a]:text-primary/80 [&_strong]:text-foreground [&_strong]:font-semibold">
						<p>
							Thank you for using RelayAPI (the "Service"), operated by us at
							relayapi.dev. This Privacy Policy explains how we collect, use,
							disclose, and safeguard your information when you use our unified
							social media API service.
						</p>

						<h3>Service Operator</h3>
						<p>
							MAJESTICO
							<br />
							Valetta Rd
							<br />
							London W3 7TW
							<br />
							United Kingdom
						</p>

						<p>
							By using our Service, you agree to the collection and use of
							information in accordance with this Privacy Policy. If you do not
							agree with our policies and practices, do not use our Service.
						</p>

						<p>
							Our Service uses YouTube API Services. By using our Service to
							interact with YouTube, you are also agreeing to be bound by the{" "}
							<a
								href="https://www.google.com/policies/privacy"
								target="_blank"
								rel="noopener noreferrer"
							>
								Google Privacy Policy
							</a>
							.
						</p>

						<p>
							For more information, please see our{" "}
							<a href="/terms">Terms of Service</a>.
						</p>

						<h2>1. Information We Collect</h2>

						<h3>1.1 Personal Information</h3>
						<ul>
							<li>
								<strong>Name:</strong> To personalize your experience and for
								account identification
							</li>
							<li>
								<strong>Email Address:</strong> For account communication,
								support, and service updates
							</li>
							<li>
								<strong>Payment Information:</strong> Processed securely through
								third-party payment providers (we do not store payment details)
							</li>
							<li>
								<strong>API Usage Data:</strong> To monitor usage limits and
								provide analytics
							</li>
						</ul>

						<h3>1.2 Social Media Account Data</h3>
						<p>
							When you connect social media accounts to our Service, we collect
							and store access tokens and basic profile information necessary to
							publish posts on your behalf.
						</p>

						<h3>1.3 Automatically Collected Information</h3>
						<ul>
							<li>IP addresses and device information</li>
							<li>Browser type and version</li>
							<li>Usage patterns and API request logs</li>
							<li>Cookies and similar tracking technologies</li>
						</ul>

						<h2>2. Legal Basis for Processing</h2>
						<p>
							Under the General Data Protection Regulation (GDPR), we process
							your personal data based on the following lawful bases:
						</p>
						<ul>
							<li>
								<strong>Contractual Necessity:</strong> Processing necessary to
								perform our contract with you, such as providing the Service,
								managing your account, and processing payments.
							</li>
							<li>
								<strong>Consent:</strong> Where you have given explicit consent
								to the processing of your personal data for specific purposes,
								such as marketing communications.
							</li>
							<li>
								<strong>Legitimate Interests:</strong> Processing necessary for
								our legitimate interests, such as improving our Service,
								preventing fraud, and ensuring security, provided these
								interests are not overridden by your rights.
							</li>
							<li>
								<strong>Legal Obligation:</strong> Processing necessary to
								comply with legal obligations, such as tax reporting and
								responding to lawful requests from authorities.
							</li>
						</ul>

						<h2>3. How We Use Your Information</h2>
						<p>We use your information for the following purposes:</p>
						<ul>
							<li>Providing and maintaining our API service</li>
							<li>Processing payments and managing subscriptions</li>
							<li>Publishing social media posts via connected accounts</li>
							<li>Monitoring API usage and enforcing rate limits</li>
							<li>Providing customer support and technical assistance</li>
							<li>Sending important service updates and notifications</li>
							<li>Improving our Service and developing new features</li>
							<li>Ensuring security and preventing fraud</li>
						</ul>

						<h2>4. Information Sharing and Disclosure</h2>
						<p>
							We do not sell, trade, or rent your personal information to third
							parties. We may share your information only in the following
							circumstances:
						</p>
						<ul>
							<li>
								<strong>Service Providers:</strong> With trusted third-party
								providers who assist in operating our Service (payment
								processors, hosting providers)
							</li>
							<li>
								<strong>Social Media Platforms:</strong> To publish content on
								your connected social media accounts as requested
							</li>
							<li>
								<strong>Legal Requirements:</strong> When required by law or to
								protect our rights and safety
							</li>
							<li>
								<strong>Business Transfers:</strong> In connection with any
								merger, sale of assets, or acquisition
							</li>
						</ul>

						<h2>5. Data Security</h2>
						<p>
							We implement appropriate technical and organizational security
							measures to protect your personal information against unauthorized
							access, alteration, disclosure, or destruction. This includes
							encryption of sensitive data, secure API endpoints, and regular
							security audits.
						</p>

						<h2>6. Data Retention</h2>
						<p>
							We retain your personal information for as long as necessary to
							provide our Service and comply with legal obligations. When you
							delete your account, we will delete or anonymize your personal
							information within 30 days, except as required by law.
						</p>

						<h2>7. Your Rights (GDPR)</h2>
						<p>
							Under the General Data Protection Regulation (GDPR) and other
							applicable data protection laws, you have the following rights
							regarding your personal data:
						</p>
						<ul>
							<li>
								<strong>Right of Access:</strong> You have the right to request
								a copy of the personal data we hold about you.
							</li>
							<li>
								<strong>Right to Rectification:</strong> You have the right to
								request correction of inaccurate or incomplete personal data.
							</li>
							<li>
								<strong>Right to Erasure:</strong> You have the right to request
								deletion of your personal data ("right to be forgotten") in
								certain circumstances.
							</li>
							<li>
								<strong>Right to Restriction:</strong> You have the right to
								request restriction of processing of your personal data in
								certain circumstances.
							</li>
							<li>
								<strong>Right to Data Portability:</strong> You have the right
								to receive your personal data in a structured, commonly used
								format and to transmit it to another controller.
							</li>
							<li>
								<strong>Right to Object:</strong> You have the right to object
								to processing of your personal data based on legitimate
								interests or for direct marketing purposes.
							</li>
							<li>
								<strong>Right to Withdraw Consent:</strong> Where processing is
								based on consent, you have the right to withdraw your consent at
								any time without affecting the lawfulness of prior processing.
							</li>
						</ul>
						<p>
							We will respond to your request within 30 days as required by
							GDPR. We may need to verify your identity before processing your
							request.
						</p>
						<p>
							To exercise any of these rights, please contact us at{" "}
							<a href="mailto:support@relayapi.dev">support@relayapi.dev</a>.
						</p>

						<h2>8. Cookies and Tracking Technologies</h2>
						<p>
							We use cookies and similar technologies to enhance your
							experience, analyze usage patterns, and maintain user sessions.
							You can control cookie preferences through your browser settings,
							though this may affect Service functionality.
						</p>

						<h2>9. Children's Privacy</h2>
						<p>
							Our Service is not intended for individuals under 18 years of age.
							We do not knowingly collect personal information from children. If
							you become aware that a child has provided us with personal
							information, please contact us immediately.
						</p>

						<h2>10. International Data Transfers</h2>
						<p>
							Your information may be transferred to and processed in countries
							other than your own. We ensure appropriate safeguards are in place
							to protect your personal information in accordance with applicable
							data protection laws.
						</p>

						<h2>11. Changes to This Privacy Policy</h2>
						<p>
							We may update this Privacy Policy from time to time. We will
							notify you of any material changes by email and by posting the
							updated policy on our website. Your continued use of the Service
							after such modifications constitutes acceptance of the updated
							Privacy Policy.
						</p>

						<h2>12. Contact Information</h2>
						<p>
							If you have any questions, concerns, or requests regarding this
							Privacy Policy or our data practices, please contact us at:
						</p>
						<p>
							MAJESTICO
							<br />
							Valetta Rd
							<br />
							London W3 7TW
							<br />
							United Kingdom
							<br />
							Email:{" "}
							<a href="mailto:support@relayapi.dev">support@relayapi.dev</a>
							<br />
							Website:{" "}
							<a
								href="https://relayapi.dev"
								target="_blank"
								rel="noopener noreferrer"
							>
								relayapi.dev
							</a>
						</p>
					</div>
				</section>

				{/* Footer */}
				<section className="border-t border-border py-4">
					<p className="text-sm text-muted-foreground text-center">
						&copy; {new Date().getFullYear()} Relay. All rights reserved.
					</p>
				</section>
			</main>
		</div>
	);
}
