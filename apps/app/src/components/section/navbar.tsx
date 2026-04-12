import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { apis } from "../../lib/api-data";
import { siteConfig } from "../../lib/config";
import { platforms } from "../../lib/platform-data";
import { Icons } from "../icons";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "../ui/accordion";
import { Button } from "../ui/button";
import {
	NavigationMenu,
	NavigationMenuContent,
	NavigationMenuItem,
	NavigationMenuLink,
	NavigationMenuList,
	NavigationMenuTrigger,
	NavigationMenuViewport,
} from "../ui/navigation-menu";

function HamburgerButton({
	isOpen,
	onClick,
}: {
	isOpen: boolean;
	onClick: () => void;
}) {
	return (
		<button
			onClick={onClick}
			className="md:hidden relative z-50 flex size-8 items-center justify-center rounded-full border border-border bg-background transition-colors hover:bg-accent"
			aria-label="Toggle menu"
		>
			<div className="relative size-5 flex items-center justify-center">
				<motion.span
					className="absolute h-0.5 w-4 bg-foreground"
					initial={false}
					animate={isOpen ? { rotate: 45, y: 0 } : { rotate: 0, y: -4 }}
					transition={{ duration: 0.25, ease: "easeInOut" }}
				/>
				<motion.span
					className="absolute h-0.5 w-4 bg-foreground"
					initial={false}
					animate={isOpen ? { rotate: -45, y: 0 } : { rotate: 0, y: 4 }}
					transition={{ duration: 0.25, ease: "easeInOut" }}
				/>
			</div>
		</button>
	);
}

function DesktopNav() {
	return (
		<NavigationMenu className="hidden md:flex">
			<NavigationMenuList className="gap-1">
				{siteConfig.nav.links.map((link) => (
					<NavigationMenuItem key={link.id}>
						{link.submenu ? (
							<>
								<NavigationMenuTrigger className="border border-transparent text-foreground rounded-full h-8 w-fit px-2 pl-3 data-[state=open]:bg-accent/50 data-[state=open]:border-border bg-transparent">
									{link.name}
								</NavigationMenuTrigger>
								<NavigationMenuContent className="p-0!">
									<div className="w-[650px] grid grid-cols-[1fr_auto]">
										<div className="p-6">
											<h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
												Platforms
											</h4>
											<div className="grid grid-cols-2 gap-1">
												{platforms.map((p) => (
													<a
														key={p.slug}
														href={`/product/${p.slug}`}
														className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground hover:bg-accent/50 transition-colors"
													>
														<span className="shrink-0 text-muted-foreground">
															{p.icon}
														</span>
														{p.name}
													</a>
												))}
											</div>
										</div>
										<div className="p-6 border-l border-border min-w-[180px]">
											<h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
												APIs
											</h4>
											<div className="flex flex-col gap-1">
												{apis.map((a) => (
													<a
														key={a.slug}
														href={`/product/${a.slug}`}
														className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground hover:bg-accent/50 transition-colors"
													>
														<span className="shrink-0 text-muted-foreground">
															{a.icon}
														</span>
														{a.name}
													</a>
												))}
											</div>
										</div>
									</div>
								</NavigationMenuContent>
							</>
						) : (
							<NavigationMenuLink
								asChild
								className="border border-transparent hover:border-border text-foreground rounded-full h-8 w-fit px-2 bg-transparent"
							>
								<a
									href={link.href}
									{...(link.href.startsWith("http")
										? { target: "_blank", rel: "noopener noreferrer" }
										: {})}
									className="group inline-flex h-8 w-fit items-center justify-center rounded-full bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
								>
									{link.name}
								</a>
							</NavigationMenuLink>
						)}
					</NavigationMenuItem>
				))}
			</NavigationMenuList>
			<NavigationMenuViewport className="shadow-2xl border border-border" />
		</NavigationMenu>
	);
}

function MobileNav({
	isOpen,
	onClose,
}: {
	isOpen: boolean;
	onClose: () => void;
}) {
	return (
		<AnimatePresence>
			{isOpen && (
				<>
					<motion.div
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.2 }}
						onClick={onClose}
						className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden"
					/>
					<motion.div
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.2 }}
						className="fixed top-0 left-0 right-0 bottom-0 z-50 w-full bg-background shadow-2xl md:hidden overflow-y-auto"
					>
						<div className="flex h-full flex-col">
							{/* Mobile menu header */}
							<div className="flex h-16 items-center justify-between px-6 border-b border-border">
								<a
									href="/"
									className="flex items-center gap-2 text-lg font-semibold"
								>
									<Icons.logo className="h-7 w-7" />
									<span>RelayAPI</span>
								</a>
								<button
									onClick={onClose}
									className="flex size-8 items-center justify-center rounded-full border border-border bg-background transition-colors hover:bg-accent"
									aria-label="Close menu"
								>
									<svg
										width="14"
										height="14"
										viewBox="0 0 14 14"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
									>
										<line x1="1" y1="1" x2="13" y2="13" />
										<line x1="13" y1="1" x2="1" y2="13" />
									</svg>
								</button>
							</div>
							<nav className="flex-1 px-6 py-8 pb-32 overflow-y-auto">
								<div className="grid grid-cols-1 gap-4">
									{siteConfig.nav.links.map((link, index) => (
										<motion.div
											key={link.id}
											initial={{
												opacity: 0,
												y: -30,
												filter: "blur(10px)",
												clipPath: "inset(100% 0% 0% 0%)",
											}}
											animate={{
												opacity: 1,
												y: 0,
												filter: "blur(0px)",
												clipPath: "inset(0% 0% 0% 0%)",
											}}
											transition={{
												delay: index * 0.1,
												duration: 0.6,
												ease: [0.16, 1, 0.3, 1],
											}}
										>
											{link.submenu ? (
												<Accordion type="single" collapsible className="w-full">
													<AccordionItem
														value={`item-${link.id}`}
														className="border-none"
													>
														<AccordionTrigger className="text-xl font-medium uppercase py-3 hover:no-underline px-0">
															{link.name}
														</AccordionTrigger>
														<AccordionContent className="data-[state=closed]:animate-none! data-[state=open]:animate-none! overflow-hidden text-sm">
															<div className="overflow-hidden pt-4">
																<motion.h5
																	className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1"
																	initial={{
																		opacity: 0,
																		y: -10,
																		filter: "blur(8px)",
																	}}
																	animate={{
																		opacity: 1,
																		y: 0,
																		filter: "blur(0px)",
																	}}
																	transition={{
																		duration: 0.4,
																		ease: [0.16, 1, 0.3, 1],
																	}}
																>
																	Platforms
																</motion.h5>
																<ul className="grid grid-cols-1 gap-1 mb-5">
																	{platforms.map((p, i) => (
																		<motion.li
																			key={p.slug}
																			initial={{
																				opacity: 0,
																				y: -20,
																				filter: "blur(8px)",
																			}}
																			animate={{
																				opacity: 1,
																				y: 0,
																				filter: "blur(0px)",
																			}}
																			transition={{
																				delay: i * 0.03,
																				duration: 0.4,
																				ease: [0.16, 1, 0.3, 1],
																			}}
																		>
																			<a
																				href={`/product/${p.slug}`}
																				onClick={onClose}
																				className="flex items-center gap-3 px-1 py-2 transition-colors"
																			>
																				<span className="shrink-0 text-muted-foreground">
																					{p.icon}
																				</span>
																				<span className="text-sm font-medium text-foreground">
																					{p.name}
																				</span>
																			</a>
																		</motion.li>
																	))}
																</ul>
																<motion.h5
																	className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1"
																	initial={{
																		opacity: 0,
																		y: -10,
																		filter: "blur(8px)",
																	}}
																	animate={{
																		opacity: 1,
																		y: 0,
																		filter: "blur(0px)",
																	}}
																	transition={{
																		delay: platforms.length * 0.03,
																		duration: 0.4,
																		ease: [0.16, 1, 0.3, 1],
																	}}
																>
																	APIs
																</motion.h5>
																<ul className="grid grid-cols-1 gap-1">
																	{apis.map((a, i) => (
																		<motion.li
																			key={a.slug}
																			initial={{
																				opacity: 0,
																				y: -20,
																				filter: "blur(8px)",
																			}}
																			animate={{
																				opacity: 1,
																				y: 0,
																				filter: "blur(0px)",
																			}}
																			transition={{
																				delay: (platforms.length + i) * 0.03,
																				duration: 0.4,
																				ease: [0.16, 1, 0.3, 1],
																			}}
																		>
																			<a
																				href={`/product/${a.slug}`}
																				onClick={onClose}
																				className="flex items-center gap-3 px-1 py-2 transition-colors"
																			>
																				<span className="shrink-0 text-muted-foreground">
																					{a.icon}
																				</span>
																				<span className="text-sm font-medium text-foreground">
																					{a.name}
																				</span>
																			</a>
																		</motion.li>
																	))}
																</ul>
															</div>
														</AccordionContent>
													</AccordionItem>
												</Accordion>
											) : (
												<a
													href={link.href}
													onClick={onClose}
													{...(link.href.startsWith("http")
														? { target: "_blank", rel: "noopener noreferrer" }
														: {})}
													className="block px-0 py-3 text-xl font-medium uppercase transition-colors hover:text-accent-foreground"
												>
													{link.name}
												</a>
											)}
										</motion.div>
									))}
								</div>
							</nav>
							<div className="sticky bottom-0 w-full p-6 bg-background border-t border-border">
								<motion.div
									initial={{
										opacity: 0,
										y: 30,
										filter: "blur(10px)",
									}}
									animate={{
										opacity: 1,
										y: 0,
										filter: "blur(0px)",
									}}
									transition={{
										delay: 0.05,
										duration: 0.6,
										ease: [0.16, 1, 0.3, 1],
									}}
								>
									<a
										href="/login"
										onClick={onClose}
										className="flex w-full h-12 items-center justify-center rounded-lg border border-border bg-transparent px-5 text-sm font-medium text-foreground transition-colors hover:bg-accent/50"
									>
										Log in
									</a>
								</motion.div>
								<motion.div
									initial={{
										opacity: 0,
										y: 30,
										filter: "blur(10px)",
									}}
									animate={{
										opacity: 1,
										y: 0,
										filter: "blur(0px)",
									}}
									transition={{
										delay: 0.1,
										duration: 0.6,
										ease: [0.16, 1, 0.3, 1],
									}}
								>
									<a href="/signup" onClick={onClose}>
										<Button className="w-full mt-3 h-12 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
											{siteConfig.cta}
										</Button>
									</a>
								</motion.div>
								<motion.div
									initial={{
										opacity: 0,
										y: 30,
										filter: "blur(10px)",
									}}
									animate={{
										opacity: 1,
										y: 0,
										filter: "blur(0px)",
									}}
									transition={{
										delay: 0.15,
										duration: 0.6,
										ease: [0.16, 1, 0.3, 1],
									}}
								>
									<a
										href="https://github.com/relayapi-dev/relayapi"
										target="_blank"
										rel="noopener noreferrer"
										className="flex w-full h-12 mt-3 items-center justify-center gap-2 rounded-lg border border-border bg-transparent px-5 text-sm font-medium text-foreground transition-colors hover:bg-accent/50"
									>
										<svg
											className="w-5 h-5"
											fill="currentColor"
											viewBox="0 0 24 24"
											aria-hidden="true"
										>
											<path
												fillRule="evenodd"
												clipRule="evenodd"
												d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
											/>
										</svg>
										GitHub
									</a>
								</motion.div>
							</div>
						</div>
					</motion.div>
				</>
			)}
		</AnimatePresence>
	);
}

export function Navbar() {
	const [isVisible, setIsVisible] = useState(true);
	const [lastScrollY, setLastScrollY] = useState(0);
	const [isScrolled, setIsScrolled] = useState(false);
	const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

	useEffect(() => {
		const handleScroll = () => {
			const currentScrollY = window.scrollY;

			setIsScrolled(currentScrollY > 20);

			if (currentScrollY < 10) {
				setIsVisible(true);
			} else if (currentScrollY > lastScrollY) {
				setIsVisible(false);
			} else if (currentScrollY < lastScrollY) {
				setIsVisible(true);
			}

			setLastScrollY(currentScrollY);
		};

		window.addEventListener("scroll", handleScroll, { passive: true });
		return () => window.removeEventListener("scroll", handleScroll);
	}, [lastScrollY]);

	useEffect(() => {
		if (isMobileMenuOpen) {
			document.body.style.overflow = "hidden";
		} else {
			document.body.style.overflow = "";
		}
		return () => {
			document.body.style.overflow = "";
		};
	}, [isMobileMenuOpen]);

	return (
		<>
			<motion.header
				initial={{ y: 0 }}
				animate={{ y: isVisible ? 0 : -100 }}
				transition={{ duration: 0.3, ease: "easeInOut" }}
				className={`fixed top-0 left-0 right-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-300 ${
					isScrolled
						? "border-b border-border bg-background/80 backdrop-blur-md"
						: "border-b border-transparent bg-transparent"
				}`}
			>
				<div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
					<a
						href="/"
						className="flex items-center gap-2.5 text-lg font-semibold"
					>
						<Icons.logo className="h-7 w-7" />
						<span>RelayAPI</span>
					</a>

					<DesktopNav />

					<div className="flex items-center gap-2">
						<a
							href="https://github.com/relayapi-dev/relayapi"
							target="_blank"
							rel="noopener noreferrer"
							className="hidden md:inline-flex pr-2 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
							aria-label="GitHub"
						>
							<svg
								className="w-5 h-5"
								fill="currentColor"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path
									fillRule="evenodd"
									clipRule="evenodd"
									d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
								/>
							</svg>
						</a>
						<a
							href="/login"
							className="hidden md:inline-flex items-center justify-center rounded-full border border-border bg-transparent px-4 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent/50"
						>
							Log in
						</a>
						<a href="/signup" className="hidden md:inline-flex">
							<Button className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full px-5 py-1.5">
								{siteConfig.cta}
							</Button>
						</a>
						<HamburgerButton
							isOpen={isMobileMenuOpen}
							onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
						/>
					</div>
				</div>
			</motion.header>

			<MobileNav
				isOpen={isMobileMenuOpen}
				onClose={() => setIsMobileMenuOpen(false)}
			/>
		</>
	);
}
