import { siteConfig } from "../../lib/config";

export function TestimonialSection() {
    const { testimonialSection } = siteConfig;

    return (
        <section
            id="testimonials"
            className="flex flex-col items-center justify-center w-full"
        >
            <div className="flex flex-col items-center justify-center gap-4 py-12">
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider text-center">
                    What developers say
                </h2>
                <p className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance">
                    {testimonialSection.title}
                </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 p-8 md:p-12">
                {testimonialSection.testimonials.slice(0, 6).map((testimonial) => (
                    <div
                        key={testimonial.id}
                        className="rounded-xl border border-border bg-card p-6 space-y-4"
                    >
                        <div className="text-sm text-foreground">
                            {testimonial.description}
                        </div>
                        <div className="flex items-center gap-3">
                            <img
                                src={testimonial.img}
                                alt={testimonial.name}
                                width={32}
                                height={32}
                                className="rounded-full object-cover w-8 h-8"
                            />
                            <div>
                                <p className="font-medium text-sm">{testimonial.name}</p>
                                <p className="text-muted-foreground text-sm">{testimonial.role}</p>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
