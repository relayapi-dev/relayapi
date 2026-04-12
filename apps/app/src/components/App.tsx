import { Navbar } from "./section/navbar";
import { HeroSection } from "./section/hero-section";
import { HeroCodeBlock } from "./section/hero-code-block";
import { CompanyShowcase } from "./section/company-showcase";
import { TestimonialSection } from "./section/testimonial-section";
import { WorkflowSection } from "./section/workflow-section";
import { FeatureSection } from "./section/feature-section";
import { PricingSection } from "./section/pricing-section";
import { FAQSection } from "./section/faq-section";
import { SelfHostSection } from "./section/self-host-section";
import { Footer } from "./section/footer";
import { CircuitLines } from "./ui/circuit-lines";

export default function App() {
  return (
    <div className="max-w-7xl mx-auto border-x border-border">
      <Navbar />
      <main className="flex flex-col divide-y divide-border pt-16">
        <div className="relative">
          <CircuitLines />
          <HeroSection />
          <HeroCodeBlock />
        </div>
        <CompanyShowcase />
        <TestimonialSection />
        <WorkflowSection />
        <FeatureSection />
        <PricingSection />
        <FAQSection />
        <SelfHostSection />
        <Footer />
      </main>
    </div>
  );
}
