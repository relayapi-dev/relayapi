import { useRef } from "react";
import { Key, Link, Send } from "lucide-react";
import { motion, useInView } from "motion/react";
import { siteConfig } from "../../lib/config";
import { SectionHeader } from "../section-header";
import { HeaderBadge } from "../header-badge";

const workflowConfig = siteConfig.workflowSection;

const steps = [
    {
        icon: Key,
        title: "Get your API key",
        description:
            "Sign up, create a workspace, and generate your API key. Start making requests immediately with our developer-friendly REST API.",
    },
    {
        icon: Link,
        title: "Connect accounts",
        description:
            "Link Twitter, Instagram, LinkedIn, TikTok, and 11 more platforms in seconds. We handle token refresh and re-auth automatically.",
    },
    {
        icon: Send,
        title: "Start posting",
        description:
            "Send a single POST request with your content and target platforms. Relay formats and delivers to each network simultaneously.",
    },
];

function StepCard({
    step,
    index,
}: {
    step: (typeof steps)[number];
    index: number;
}) {
    const ref = useRef(null);
    const inView = useInView(ref, { once: true, margin: "-100px" });
    const stepNumber = String(index + 1).padStart(2, "0");

    return (
        <motion.div
            ref={ref}
            initial={{ opacity: 0, y: 24 }}
            animate={inView ? { opacity: 1, y: 0 } : {}}
            transition={{
                type: "spring",
                stiffness: 100,
                damping: 20,
                delay: index * 0.15,
            }}
            className="relative flex flex-col items-center text-center z-10"
        >
            <span className="text-[80px] md:text-[96px] font-bold leading-none tracking-tighter text-primary/[0.07] select-none font-mono">
                {stepNumber}
            </span>

            <div className="-mt-10 flex h-12 w-12 items-center justify-center rounded-full bg-card border border-border relative z-10">
                <step.icon className="size-5 text-foreground" />
            </div>

            <h3 className="text-lg font-bold mt-5">{step.title}</h3>

            <p className="text-muted-foreground text-sm mt-2 max-w-xs">
                {step.description}
            </p>
        </motion.div>
    );
}

export function WorkflowSection() {
    return (
        <section id="workflow" className="w-full relative">
            <SectionHeader>
                <HeaderBadge
                    icon={workflowConfig.badge.icon}
                    text={workflowConfig.badge.text}
                />
                <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance">
                    {workflowConfig.title}
                </h2>
                <p className="text-muted-foreground text-center text-balance text-sm">
                    {workflowConfig.description}
                </p>
            </SectionHeader>

            <div className="relative px-8 py-12 md:px-12 md:py-16">
                {/* Horizontal connecting dashed line (desktop only) */}
                <div className="hidden md:block absolute top-[calc(50%-16px)] left-[16.67%] right-[16.67%] border-t-2 border-dashed border-border z-0" />

                <div className="grid grid-cols-1 gap-12 md:grid-cols-3 md:gap-6 relative">
                    {steps.map((step, index) => (
                        <StepCard key={step.title} step={step} index={index} />
                    ))}
                </div>
            </div>
        </section>
    );
}
