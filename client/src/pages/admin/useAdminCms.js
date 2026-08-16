import { useCallback, useEffect, useState } from "react";
import { fetchPublicSettings, fetchPublicOfferings } from "../../api/public";
import {
  updateHero,
  updateContact,
  updateAbout,
  updateHome,
  updateFooter,
  updateEnrolButton,
  fetchHowItWorksSteps,
  createHowItWorksStep,
  updateHowItWorksStep,
  deleteHowItWorksStep,
  fetchFaqs,
  createFaq,
  updateFaq,
  deleteFaq,
  fetchGalleryImages,
  createGalleryImage,
  updateGalleryImage,
  deleteGalleryImage,
  fetchPartners,
  createPartner,
  updatePartner,
  deletePartner,
  createSuccessStory,
  deleteSuccessStory,
  fetchBlogPosts,
  createBlogPost,
  updateBlogPost,
  deleteBlogPost,
} from "../../api/admin";
import { isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

export const CMS_TABS = [
  { key: "hero", label: "Hero & Contact" },
  { key: "about", label: "About Us" },
  { key: "home", label: "Home Page Copy" },
  { key: "howItWorks", label: "How It Works" },
  { key: "faqs", label: "FAQ" },
  { key: "gallery", label: "Gallery" },
  { key: "partners", label: "Partners" },
  { key: "stories", label: "Success Stories" },
  { key: "blog", label: "News / Blog" },
  { key: "enrolButton", label: "Enrol Button" },
  { key: "footer", label: "Footer" },
];

/**
 * Data/state for the Landing Page CMS screen (Phase 28). Migrates legacy
 * adminCms()/switchCmsTab() (dashboard.html): each tab loads its own data
 * lazily the first time it's opened (matching legacy's per-tab renderer
 * functions cmsRenderAbout/cmsRenderHome/etc. and settingsLanding/
 * settingsStories/settingsBlog, which the legacy CMS tab bar reused
 * as-is), then caches it in state until a mutation reloads it.
 *
 * Every tab here reads/writes the exact same /api/settings/... endpoints
 * as Site Settings (server/src/routes/settings.js) — requireAuth +
 * requirePermission("siteSettings.edit") to mutate (list reads also
 * accept "siteSettings.view"). This page is already behind the admin
 * RoleRoute, but a stale/narrower permission set still gets a real,
 * handled 403 here — hiding a control client-side is never treated as
 * the actual authorization boundary; the backend gate is unchanged.
 *
 * The public landing page (usePublicLandingData.js) reads this same
 * content via GET /api/settings/public — no second CMS data source.
 */
export function useAdminCms() {
  const { refresh } = useAuth();

  const [activeTab, setActiveTab] = useState("hero");

  // One entry per tab: { status: "idle"|"loading"|"ready"|"error"|"forbidden", data, error }
  const [tabs, setTabsState] = useState(() =>
    Object.fromEntries(CMS_TABS.map((t) => [t.key, { status: "idle", data: null, error: null }]))
  );

  const setTab = useCallback((key, patch) => {
    setTabsState((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  }, []);

  const loaders = {
    hero: async () => {
      const s = await fetchPublicSettings();
      return { hero: s.hero || {}, contact: s.contact || {} };
    },
    about: async () => {
      const s = await fetchPublicSettings();
      return { about: s.about || {} };
    },
    home: async () => {
      const s = await fetchPublicSettings();
      return { home: s.home || {} };
    },
    howItWorks: async () => {
      const steps = await fetchHowItWorksSteps();
      return { steps };
    },
    faqs: async () => {
      const faqs = await fetchFaqs();
      return { faqs };
    },
    gallery: async () => {
      const images = await fetchGalleryImages();
      return { images };
    },
    partners: async () => {
      const partners = await fetchPartners();
      return { partners };
    },
    // No dedicated admin "all stories" endpoint exists — legacy's
    // loadStoriesList() reuses DTL.publicSettings() too.
    stories: async () => {
      const s = await fetchPublicSettings();
      return { stories: s.stories || [] };
    },
    blog: async () => {
      const posts = await fetchBlogPosts();
      return { posts };
    },
    enrolButton: async () => {
      const [s, offerings] = await Promise.all([fetchPublicSettings(), fetchPublicOfferings().catch(() => [])]);
      return { enrolButton: s.enrolButton || {}, offerings: offerings || [] };
    },
    footer: async () => {
      const s = await fetchPublicSettings();
      return { footer: s.footer || {} };
    },
  };

  const load = useCallback(
    async (key) => {
      setTab(key, { status: "loading", error: null });
      try {
        const data = await loaders[key]();
        setTab(key, { status: "ready", data });
      } catch (e) {
        if (isUnauthorizedError(e)) {
          await refresh();
          return;
        }
        if (isForbiddenError(e)) {
          setTab(key, { status: "forbidden", error: e.message });
          return;
        }
        setTab(key, { status: "error", error: e.message });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setTab, refresh]
  );

  // Load the active tab the first time it's selected.
  useEffect(() => {
    if (tabs[activeTab] && tabs[activeTab].status === "idle") load(activeTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  function reload(key) {
    return load(key);
  }

  /* ---------------------------------------------------------------------
     Hero & Contact
     --------------------------------------------------------------------- */
  async function saveHero(payload) {
    await updateHero(payload);
    await load("hero");
  }
  async function saveContact(payload) {
    await updateContact(payload);
    await load("hero");
  }

  /* ---------------------------------------------------------------------
     About Us
     --------------------------------------------------------------------- */
  async function saveAbout(payload) {
    await updateAbout(payload);
    await load("about");
  }

  /* ---------------------------------------------------------------------
     Home Page Copy
     --------------------------------------------------------------------- */
  async function saveHome(payload) {
    await updateHome(payload);
    await load("home");
  }

  /* ---------------------------------------------------------------------
     How It Works
     --------------------------------------------------------------------- */
  async function saveHowItWorksStep(id, payload) {
    if (id) await updateHowItWorksStep(id, payload);
    else await createHowItWorksStep(payload);
    await load("howItWorks");
  }
  async function removeHowItWorksStep(id) {
    await deleteHowItWorksStep(id);
    await load("howItWorks");
  }

  /* ---------------------------------------------------------------------
     FAQs
     --------------------------------------------------------------------- */
  async function saveFaq(id, payload) {
    if (id) await updateFaq(id, payload);
    else await createFaq(payload);
    await load("faqs");
  }
  async function removeFaq(id) {
    await deleteFaq(id);
    await load("faqs");
  }

  /* ---------------------------------------------------------------------
     Gallery
     --------------------------------------------------------------------- */
  async function addGalleryImage(payload) {
    await createGalleryImage(payload);
    await load("gallery");
  }
  async function toggleGalleryActive(id, active) {
    await updateGalleryImage(id, { active });
    await load("gallery");
  }
  async function removeGalleryImage(id) {
    await deleteGalleryImage(id);
    await load("gallery");
  }

  /* ---------------------------------------------------------------------
     Partners
     --------------------------------------------------------------------- */
  async function addPartner(payload) {
    await createPartner(payload);
    await load("partners");
  }
  async function togglePartnerActive(id, active) {
    await updatePartner(id, { active });
    await load("partners");
  }
  async function removePartner(id) {
    await deletePartner(id);
    await load("partners");
  }

  /* ---------------------------------------------------------------------
     Success Stories
     --------------------------------------------------------------------- */
  async function addStory(payload) {
    await createSuccessStory(payload);
    await load("stories");
  }
  async function removeStory(id) {
    await deleteSuccessStory(id);
    await load("stories");
  }

  /* ---------------------------------------------------------------------
     News / Blog
     --------------------------------------------------------------------- */
  async function addBlogPost(payload) {
    await createBlogPost(payload);
    await load("blog");
  }
  async function saveBlogPost(id, payload) {
    await updateBlogPost(id, payload);
    await load("blog");
  }
  async function toggleBlogPublished(id, published) {
    await updateBlogPost(id, { published });
    await load("blog");
  }
  async function removeBlogPost(id) {
    await deleteBlogPost(id);
    await load("blog");
  }

  /* ---------------------------------------------------------------------
     Enrol Button
     --------------------------------------------------------------------- */
  async function saveEnrolButton(payload) {
    await updateEnrolButton(payload);
    await load("enrolButton");
  }

  /* ---------------------------------------------------------------------
     Footer
     --------------------------------------------------------------------- */
  async function saveFooter(payload) {
    await updateFooter(payload);
    await load("footer");
  }

  return {
    tabs,
    activeTab,
    setActiveTab,
    reload,
    saveHero,
    saveContact,
    saveAbout,
    saveHome,
    saveHowItWorksStep,
    removeHowItWorksStep,
    saveFaq,
    removeFaq,
    addGalleryImage,
    toggleGalleryActive,
    removeGalleryImage,
    addPartner,
    togglePartnerActive,
    removePartner,
    addStory,
    removeStory,
    addBlogPost,
    saveBlogPost,
    toggleBlogPublished,
    removeBlogPost,
    saveEnrolButton,
    saveFooter,
  };
}
