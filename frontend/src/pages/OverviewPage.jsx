import HeroSection from '../components/overview/HeroSection.jsx';
import ProcessSection from '../components/overview/ProcessSection.jsx';
import useScrollReveal from '../hooks/useScrollReveal.js';
export default function OverviewPage() {
  const revealRef = useScrollReveal();
  return (
    <div ref={revealRef} className="overview-page">
      <HeroSection />
      <ProcessSection />
    </div>
  );
}
