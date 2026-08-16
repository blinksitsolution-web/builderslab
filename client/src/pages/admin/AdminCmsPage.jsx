import { useAdminCms, CMS_TABS } from "./useAdminCms";
import { PageHeader, Tabs, TabPanel } from "../../components/ui";
import CmsHeroContactTab from "./CmsHeroContactTab";
import CmsAboutTab from "./CmsAboutTab";
import CmsHomeCopyTab from "./CmsHomeCopyTab";
import CmsHowItWorksTab from "./CmsHowItWorksTab";
import CmsFaqsTab from "./CmsFaqsTab";
import CmsGalleryTab from "./CmsGalleryTab";
import CmsPartnersTab from "./CmsPartnersTab";
import CmsStoriesTab from "./CmsStoriesTab";
import CmsBlogTab from "./CmsBlogTab";
import CmsEnrolButtonTab from "./CmsEnrolButtonTab";
import CmsFooterTab from "./CmsFooterTab";

/**
 * Landing Page CMS (Phase 28). Migrates legacy adminCms() (dashboard.html)
 * in full: Hero & Contact, About Us, Home Page Copy, How It Works, FAQ,
 * Gallery, Partners, Success Stories, News/Blog, Enrol Button, and Footer.
 *
 * Campuses, Fees, Branding and Learning Offering Types stay in Site
 * Settings (they're also used outside the public landing page) — same
 * split as legacy's adminCms()/adminSettings() and this project's
 * AdminSettingsPage.jsx.
 *
 * Every tab's data loads lazily the first time it's opened (see
 * useAdminCms.js) and every mutation still goes through the backend's
 * existing siteSettings.edit/siteSettings.view permission gates —
 * nothing here re-derives or weakens those.
 */
export default function AdminCmsPage() {
  const cms = useAdminCms();

  return (
    <div>
      <PageHeader
        title="Landing Page CMS"
        description="Hero, Contact details, About Us, Home page copy, Footer, the global Enrol Button, How It Works, FAQs, Gallery, Partners, Success Stories and News/Blog — everything that only affects the public Landing Page. Campuses, Fees, Branding and Featured Learning Offerings are system-wide and stay in Site Settings."
      />

      <Tabs tabs={CMS_TABS} active={cms.activeTab} onChange={cms.setActiveTab} />

      <div style={{ marginTop: 20 }}>
        <TabPanel tabKey="hero" active={cms.activeTab}>
          <CmsHeroContactTab cms={cms} />
        </TabPanel>
        <TabPanel tabKey="about" active={cms.activeTab}>
          <CmsAboutTab cms={cms} />
        </TabPanel>
        <TabPanel tabKey="home" active={cms.activeTab}>
          <CmsHomeCopyTab cms={cms} />
        </TabPanel>
        <TabPanel tabKey="howItWorks" active={cms.activeTab}>
          <CmsHowItWorksTab cms={cms} />
        </TabPanel>
        <TabPanel tabKey="faqs" active={cms.activeTab}>
          <CmsFaqsTab cms={cms} />
        </TabPanel>
        <TabPanel tabKey="gallery" active={cms.activeTab}>
          <CmsGalleryTab cms={cms} />
        </TabPanel>
        <TabPanel tabKey="partners" active={cms.activeTab}>
          <CmsPartnersTab cms={cms} />
        </TabPanel>
        <TabPanel tabKey="stories" active={cms.activeTab}>
          <CmsStoriesTab cms={cms} />
        </TabPanel>
        <TabPanel tabKey="blog" active={cms.activeTab}>
          <CmsBlogTab cms={cms} />
        </TabPanel>
        <TabPanel tabKey="enrolButton" active={cms.activeTab}>
          <CmsEnrolButtonTab cms={cms} />
        </TabPanel>
        <TabPanel tabKey="footer" active={cms.activeTab}>
          <CmsFooterTab cms={cms} />
        </TabPanel>
      </div>
    </div>
  );
}
