import { useEffect, useState } from "react";
import { fetchPublicSettings, fetchCampuses, fetchPublicOfferings } from "../../api/public";
import { fetchModules } from "../../api/learner";

/**
 * Mirrors legacy index.html's four independent IIFEs (loadLanding,
 * loadModules, loadCampuses, loadOfferings — see Phase 9 analysis):
 * each of settings/modules/campuses/offerings loads on its own, and a
 * failure in one is swallowed silently rather than surfaced as an error
 * — "static fallback content already in the HTML is fine offline" is the
 * *actual existing* public-page UX, not a shortcut this migration is
 * introducing. Components consuming this hook render CMS-provided
 * content when present and their own static fallback otherwise, exactly
 * like the legacy page's `if (data.hero) {...}` conditionals.
 */
export function usePublicLandingData() {
  const [settings, setSettings] = useState(null);
  const [modules, setModules] = useState(null);
  const [campuses, setCampuses] = useState(null);
  const [offerings, setOfferings] = useState(null);

  useEffect(() => {
    fetchPublicSettings()
      .then(setSettings)
      .catch(() => {});
    fetchModules()
      .then(setModules)
      .catch(() => {});
    fetchCampuses()
      .then(setCampuses)
      .catch(() => {});
    fetchPublicOfferings()
      .then(setOfferings)
      .catch(() => {});
  }, []);

  return { settings, modules, campuses, offerings };
}
