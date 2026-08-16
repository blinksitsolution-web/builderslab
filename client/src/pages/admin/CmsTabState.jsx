import { LoadingState, ErrorState, UnauthorizedState } from "../../components/ui";

/**
 * Shared loading/error/forbidden gate for a single Landing Page CMS tab's
 * `{ status, data, error }` entry (see useAdminCms.js). Keeps each tab
 * component focused on its own fields instead of repeating this
 * boilerplate — same four states every other migrated admin tab in this
 * project handles (see SettingsCertificatesTab.jsx et al.).
 */
export default function CmsTabState({ tab, loadingLabel, forbiddenDescription, onRetry, children }) {
  if (tab.status === "loading" || tab.status === "idle") return <LoadingState label={loadingLabel} />;
  if (tab.status === "forbidden") return <UnauthorizedState description={forbiddenDescription} />;
  if (tab.status === "error") return <ErrorState description={tab.error} action={{ label: "Try again", onClick: onRetry }} />;
  return children(tab.data);
}
