import { Navbar } from "../section/navbar";

export function TermsPage() {
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
						Terms of Service
					</h1>
					<p className="text-lg text-muted-foreground max-w-2xl mx-auto mt-6 text-balance">
						Last updated: March 23, 2026
					</p>
				</section>

				{/* Content */}
				<section className="py-12 md:py-16 px-6">
					<div className="max-w-3xl mx-auto text-foreground [&_h2]:text-2xl [&_h2]:font-bold [&_h2]:tracking-tight [&_h2]:mt-10 [&_h2]:mb-4 [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:tracking-tight [&_h3]:mt-8 [&_h3]:mb-3 [&_p]:text-muted-foreground [&_p]:leading-7 [&_p]:mb-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-4 [&_ul]:text-muted-foreground [&_li]:mb-2 [&_li]:leading-7 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 hover:[&_a]:text-primary/80 [&_strong]:text-foreground [&_strong]:font-semibold">
						<h2>1. Agreement to Terms</h2>
						<p>
							By accessing and using RelayAPI (the "Service"), available at
							relayapi.dev, you agree to be bound by these Terms of Service
							("Terms"). If you disagree with any part of these terms, then you
							may not access the Service.
						</p>
						<p>The Service is operated by:</p>
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
							By using our Service to interact with YouTube, you agree to be
							bound by the{" "}
							<a
								href="https://www.youtube.com/t/terms"
								target="_blank"
								rel="noopener noreferrer"
							>
								YouTube Terms of Service
							</a>
							.
						</p>

						<h2>2. Description of Service</h2>
						<p>
							RelayAPI provides a unified social media API for developers,
							enabling you to publish posts across multiple platforms including
							TikTok, Instagram, Facebook, YouTube, LinkedIn, Twitter/X,
							Threads, Pinterest, Bluesky, and more through our REST API.
						</p>

						<h2>3. API Usage and Limits</h2>
						<p>
							Your use of our API is subject to rate limits and usage quotas
							based on your subscription plan. You agree not to exceed these
							limits or attempt to circumvent them. Abuse of the API may result
							in immediate suspension of your account.
						</p>

						<h2>4. Payment and Billing</h2>
						<p>
							Subscription fees are billed in advance on a monthly or annual
							basis. All fees are non-refundable except as required by law. We
							offer a 7-day refund period from the date of purchase. You may
							cancel your subscription at any time through your account
							dashboard.
						</p>

						<h2>5. Data and Privacy</h2>
						<p>
							We collect and process personal data including your name, email,
							and payment information to provide our services. For detailed
							information about how we handle your data, please refer to our{" "}
							<a href="/privacy">Privacy Policy</a>.
						</p>

						<h2>6. Acceptable Use</h2>
						<p>
							You agree to use our Service only for lawful purposes and in
							accordance with these Terms. You may not use the Service to post
							content that is illegal, harmful, threatening, abusive, harassing,
							defamatory, or otherwise objectionable.
						</p>

						<h2>7. Intellectual Property</h2>
						<p>
							The Service and its original content, features, and functionality
							are and will remain the exclusive property of RelayAPI and its
							licensors. The Service is protected by copyright, trademark, and
							other laws.
						</p>

						<h2>8. Termination</h2>
						<p>
							We may terminate or suspend your account and bar access to the
							Service immediately, without prior notice or liability, for any
							reason whatsoever, including without limitation if you breach the
							Terms.
						</p>

						<h2>9. Disclaimer</h2>
						<p>
							The information on this Service is provided on an "as is" basis.
							To the fullest extent permitted by law, RelayAPI excludes all
							representations, warranties, conditions and other terms which
							might otherwise be implied by statute, common law or the law of
							equity.
						</p>

						<h2>10. Governing Law</h2>
						<p>
							These Terms shall be interpreted and governed by the laws of
							England and Wales. Any disputes arising from these Terms shall be
							subject to the exclusive jurisdiction of the courts of England and
							Wales.
						</p>

						<h2>11. Changes to Terms</h2>
						<p>
							We reserve the right to modify or replace these Terms at any time.
							If a revision is material, we will provide at least 30 days notice
							prior to any new terms taking effect.
						</p>

						<h2>12. Contact Information</h2>
						<p>
							If you have any questions about these Terms of Service, please
							contact us at:
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
