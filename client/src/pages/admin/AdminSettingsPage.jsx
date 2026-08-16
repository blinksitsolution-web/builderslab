import { useAdminSettings } from "./useAdminSettings";
import { PageHeader, Tabs, TabPanel } from "../../components/ui";
import SettingsFeesTab from "./SettingsFeesTab";
import SettingsBrandingTab from "./SettingsBrandingTab";
import SettingsCampusesTab from "./SettingsCampusesTab";
import SettingsModulesTab from "./SettingsModulesTab";
import SettingsCourseGroupsTab from "./SettingsCourseGroupsTab";
import SettingsCalendarTab from "./SettingsCalendarTab";
import SettingsCertificatesTab from "./SettingsCertificatesTab";
import SettingsCampusBrandingTab from "./SettingsCampusBrandingTab";
import SettingsApiKeysTab from "./SettingsApiKeysTab";

/**
 * Site Settings / System Configuration (Phase 27). Migrates legacy
 * adminSettings() (dashboard.html) in full: Fees & Payment Accounts,
 * Branding, Campuses, Modules & Seasons, Academic Calendar, Certificate
 * Settings, Campus Branding, and (Super Administrator-only) API Keys.
 *
 * Landing Page CMS — hero/contact/about/home/footer/enrol button/how it
 * works/FAQs/gallery/partners/success stories/blog — is legacy's separate
 * #cms tab bar, not part of adminSettings() at all, and is intentionally
 * NOT migrated here (reserved for Phase 28).
 *
 * Every tab's data loads lazily the first time it's opened (see
 * useAdminSettings.js) and every mutation still goes through the
 * backend's existing permission/role gates — nothing here re-derives or
 * weakens those.
 */
export default function AdminSettingsPage() {
  const settings = useAdminSettings();

  return (
    <div>
      <PageHeader
        title="Site Settings"
        description="Fees, branding, campuses, modules, the academic calendar and certificate configuration for the whole platform. Landing Page CMS content is managed separately."
      />

      <Tabs tabs={settings.visibleTabs} active={settings.activeTab} onChange={settings.setActiveTab} />

      <div style={{ marginTop: 20 }}>
        <TabPanel tabKey="fees" active={settings.activeTab}>
          <SettingsFeesTab settings={settings} />
        </TabPanel>
        <TabPanel tabKey="branding" active={settings.activeTab}>
          <SettingsBrandingTab settings={settings} />
        </TabPanel>
        <TabPanel tabKey="campuses" active={settings.activeTab}>
          <SettingsCampusesTab settings={settings} />
        </TabPanel>
        <TabPanel tabKey="modules" active={settings.activeTab}>
          <SettingsModulesTab settings={settings} />
        </TabPanel>
        <TabPanel tabKey="courseGroups" active={settings.activeTab}>
          <SettingsCourseGroupsTab settings={settings} />
        </TabPanel>
        <TabPanel tabKey="calendar" active={settings.activeTab}>
          <SettingsCalendarTab settings={settings} />
        </TabPanel>
        <TabPanel tabKey="certificates" active={settings.activeTab}>
          <SettingsCertificatesTab settings={settings} />
        </TabPanel>
        <TabPanel tabKey="campusBranding" active={settings.activeTab}>
          <SettingsCampusBrandingTab settings={settings} />
        </TabPanel>
        {settings.isSuperAdmin && (
          <TabPanel tabKey="apiKeys" active={settings.activeTab}>
            <SettingsApiKeysTab settings={settings} />
          </TabPanel>
        )}
      </div>
    </div>
  );
}
