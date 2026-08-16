import { useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { updateProfile, uploadAvatar, changePassword } from "../api/users";
import { isStrongPassword, passwordMessage } from "../utils/validators";
import { PageHeader, Card, Button, Input, FormField, Alert, Avatar, Spinner } from "../components/ui";

const ROLE_LABEL = { learner: "Learner", parent: "Parent", instructor: "Instructor", admin: "Administrator" };

function formatJoined(dateStr) {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return dateStr;
  }
}

/**
 * One shared Profile page for every role (learner, parent, instructor,
 * admin) rather than four near-identical per-portal copies — the
 * underlying backend endpoints (PATCH /:userId/profile,
 * POST /:userId/avatar, POST /:userId/password, all in routes/users.js)
 * were already fully built and self-service-gated (a caller can only ever
 * act on their own account, see requireSelfParentOrStaff/the explicit
 * `req.user.id !== req.params.userId` checks) — this was purely a missing
 * frontend surface, not a missing capability. Reachable at /app/profile,
 * outside any role-specific route group (see routing/AppRoutes.jsx), and
 * linked from Topbar.jsx's account menu for every role.
 */
export default function ProfilePage() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const fileInputRef = useRef(null);

  const [name, setName] = useState(user?.name || "");
  const [phone, setPhone] = useState(user?.phone || "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState("");

  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState("");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  if (!user) return null;

  async function handleSaveProfile(e) {
    e.preventDefault();
    setProfileError("");
    if (!name.trim()) {
      setProfileError("Name can't be empty.");
      return;
    }
    setSavingProfile(true);
    try {
      await updateProfile(user.id, { name: name.trim(), phone: phone.trim() });
      await refresh();
      toast.success("Profile updated.");
    } catch (err) {
      setProfileError(err.message || "Couldn't save your profile.");
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleAvatarSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // lets picking the exact same file again re-trigger onChange
    if (!file) return;
    setAvatarError("");
    setAvatarUploading(true);
    try {
      await uploadAvatar(user.id, file);
      await refresh();
      toast.success("Profile picture updated.");
    } catch (err) {
      setAvatarError(err.message || "Couldn't upload that image.");
    } finally {
      setAvatarUploading(false);
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    setPasswordError("");
    if (!currentPassword) {
      setPasswordError("Enter your current password.");
      return;
    }
    if (!isStrongPassword(newPassword)) {
      setPasswordError(passwordMessage(newPassword));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Your new password and confirmation don't match.");
      return;
    }
    setChangingPassword(true);
    try {
      await changePassword(user.id, { currentPassword, newPassword, confirmNewPassword: confirmPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password changed.");
    } catch (err) {
      setPasswordError(err.message || "Couldn't change your password.");
    } finally {
      setChangingPassword(false);
    }
  }

  return (
    <div>
      <PageHeader title="My Profile" description="View and update your own account details." />

      <div style={{ display: "grid", gap: "var(--space-5)", maxWidth: 640 }}>
        {/* ---- Profile picture ------------------------------------------------ */}
        <Card padding>
          <h3 style={{ marginTop: 0 }}>Profile picture</h3>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
            <div style={{ position: "relative" }}>
              <Avatar avatarPath={user.avatarPath} name={user.name} size="lg" />
              {avatarUploading && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "var(--radius-full)",
                    background: "rgba(0,0,0,0.4)",
                  }}
                >
                  <Spinner size="sm" />
                </div>
              )}
            </div>
            <div>
              <Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={avatarUploading}>
                Change picture
              </Button>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleAvatarSelected} style={{ display: "none" }} />
              <p className="text-helper" style={{ marginTop: "var(--space-2)", marginBottom: 0 }}>
                JPG or PNG, up to 8MB.
              </p>
            </div>
          </div>
          {avatarError && (
            <div style={{ marginTop: "var(--space-3)" }}>
              <Alert variant="danger">{avatarError}</Alert>
            </div>
          )}
        </Card>

        {/* ---- Profile info ---------------------------------------------------- */}
        <Card padding>
          <h3 style={{ marginTop: 0 }}>Profile information</h3>
          <form onSubmit={handleSaveProfile}>
            <FormField label="Full name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </FormField>
            <FormField label="Phone number">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 054 294 7685" />
            </FormField>
            <FormField label="Email" helperText="Contact an administrator to change the email on your account.">
              <Input value={user.email || ""} disabled />
            </FormField>
            <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
              <div>
                <p className="text-label" style={{ marginBottom: "var(--space-1)" }}>
                  Role
                </p>
                <p style={{ margin: 0 }}>
                  {ROLE_LABEL[user.role] || user.role}
                  {user.is_adult ? " · Adult learner" : ""}
                </p>
              </div>
              {user.campus && (
                <div>
                  <p className="text-label" style={{ marginBottom: "var(--space-1)" }}>
                    Campus
                  </p>
                  <p style={{ margin: 0 }}>{user.campus}</p>
                </div>
              )}
              <div>
                <p className="text-label" style={{ marginBottom: "var(--space-1)" }}>
                  Joined
                </p>
                <p style={{ margin: 0 }}>{formatJoined(user.joined_date)}</p>
              </div>
            </div>

            {profileError && (
              <div style={{ marginBottom: "var(--space-4)" }}>
                <Alert variant="danger">{profileError}</Alert>
              </div>
            )}
            <Button type="submit" loading={savingProfile} disabled={savingProfile}>
              Save changes
            </Button>
          </form>
        </Card>

        {/* ---- Change password --------------------------------------------- */}
        <Card padding>
          <h3 style={{ marginTop: 0 }}>Change password</h3>
          <form onSubmit={handleChangePassword}>
            <FormField label="Current password" required>
              <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
            </FormField>
            <FormField label="New password" required helperText="At least 8 characters, with at least one letter and one number.">
              <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
            </FormField>
            <FormField label="Confirm new password" required>
              <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
            </FormField>

            {passwordError && (
              <div style={{ marginBottom: "var(--space-4)" }}>
                <Alert variant="danger">{passwordError}</Alert>
              </div>
            )}
            <Button type="submit" variant="secondary" loading={changingPassword} disabled={changingPassword}>
              Change password
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
