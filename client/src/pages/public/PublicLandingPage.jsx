import { usePublicLandingData } from "./usePublicLandingData";
import { resolveEnrolDestination } from "./publicUtils";
import PublicHeader from "./PublicHeader";
import LandingHero from "./LandingHero";
import AboutSection from "./AboutSection";
import StatStrip from "./StatStrip";
import OfferingsSection from "./OfferingsSection";
import ParticipationPathwaysSection from "./ParticipationPathwaysSection";
import ModulesSection from "./ModulesSection";
import PathwaySection from "./PathwaySection";
import CampusesSection from "./CampusesSection";
import StoriesSection from "./StoriesSection";
import GallerySection from "./GallerySection";
import NewsSection from "./NewsSection";
import PartnersSection from "./PartnersSection";
import FaqSection from "./FaqSection";
import ContactSection from "./ContactSection";
import CtaBand from "./CtaBand";
import PublicFooter from "./PublicFooter";

const DEFAULT_HERO_TITLE = 'Become a <span class="accent">Builder</span> today.';
const DEFAULT_HERO_LEAD =
  "39% of today's workplace skills will be transformed or made obsolete by AI, automation and robotics before your child enters the workforce <em>(World Economic Forum, Future of Jobs Report)</em>. The Builders' Lab trains ages 6 and up — hands-on, right inside your school's own ICT lab.";

/**
 * Public landing page (Phase 9) — a React port of legacy index.html.
 * Public route, no ProtectedRoute/RoleRoute (see routing/AppRoutes.jsx).
 * All content sourced from the same CMS-backed public endpoints the
 * legacy page calls (see api/public.js), with the exact same static
 * fallback content baked in for when a section hasn't been configured in
 * the CMS yet or a request fails — matching the legacy page's own
 * behavior, not inventing new copy.
 */
export default function PublicLandingPage() {
  const { settings, modules, campuses, offerings } = usePublicLandingData();

  const logoSrc = settings?.branding?.logoPath || "/images/DTH.jpg";

  const heroTitle = (settings?.hero?.title || "Become a Builder today.").replace(/\b(Builder)\b/, '<span class="accent">$1</span>');
  const heroTitleHtml = settings?.hero ? heroTitle : DEFAULT_HERO_TITLE;
  const heroLead = settings?.hero?.lead || DEFAULT_HERO_LEAD;
  const heroEyebrow = settings?.hero?.eyebrow || "// From Consumers to Creators";

  // The global Enrol button destination — an admin-configured target
  // offering wins; otherwise the plain React registration route
  // (Group 1 migration — see routing/AppRoutes.jsx).
  let enrolHref = "/app/register";
  if (settings?.enrolButton?.targetOfferingSlug && offerings) {
    const target = offerings.find((o) => o.slug === settings.enrolButton.targetOfferingSlug);
    if (target) enrolHref = resolveEnrolDestination(target);
  }
  const enrolLabel = settings?.enrolButton?.visible === false ? null : settings?.enrolButton?.text || "Enrol now";

  return (
    <div>
      {enrolLabel !== null && <PublicHeader logoSrc={logoSrc} enrolHref={enrolHref} enrolLabel={enrolLabel} />}

      <LandingHero
        eyebrow={heroEyebrow}
        title={heroTitleHtml}
        lead={heroLead}
        enrolHref={enrolHref}
        moduleCount={modules ? modules.length : 6}
        campusCount={campuses ? campuses.length : 2}
        modules={modules}
      />

      <AboutSection about={settings?.about} />
      <StatStrip home={settings?.home} />
      <OfferingsSection offerings={offerings} home={settings?.home} />
      <ParticipationPathwaysSection home={settings?.home} />
      <ModulesSection modules={modules} />
      <PathwaySection home={settings?.home} howItWorks={settings?.howItWorks} fees={settings?.fees} />
      <CampusesSection campuses={campuses} offerings={offerings} home={settings?.home} />
      <StoriesSection stories={settings?.stories} home={settings?.home} />
      <GallerySection gallery={settings?.gallery} />
      <NewsSection blog={settings?.blog} home={settings?.home} />
      <PartnersSection partners={settings?.partners} />
      <FaqSection faqs={settings?.faqs} />
      <ContactSection contact={settings?.contact} campuses={campuses} />
      <CtaBand home={settings?.home} enrolHref={enrolHref} />
      <PublicFooter logoSrc={logoSrc} footer={settings?.footer} campuses={campuses} />
    </div>
  );
}
