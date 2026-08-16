import styles from "./Avatar.module.css";

/**
 * Shows `avatarPath` (an uploaded profile picture — see
 * POST /api/users/:userId/avatar) as a circular image, or an initial-
 * letter fallback identical to what Topbar always showed before every
 * account could actually set a picture. Used by Topbar and ProfilePage
 * so "does this user have an avatar" is decided in exactly one place.
 *
 * @param {string|null} [avatarPath] - e.g. "/uploads/avatars/xxx.jpg"
 * @param {string} name - used for the fallback initial and alt text
 * @param {"sm"|"md"|"lg"} [size]
 */
export default function Avatar({ avatarPath, name, size = "md", className = "" }) {
  const cls = [styles.avatar, styles[size], className].filter(Boolean).join(" ");
  if (avatarPath) {
    return <img src={avatarPath} alt={`${name || "User"}'s profile picture`} className={cls} />;
  }
  return (
    <span className={cls} aria-hidden="true">
      {name?.[0]?.toUpperCase() || "?"}
    </span>
  );
}
