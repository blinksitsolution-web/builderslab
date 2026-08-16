import { useRef, useState } from "react";
import { Card, CardHeader, Button, Badge, DataTable, FormField, Input, ConfirmationDialog } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import CmsTabState from "./CmsTabState";

/**
 * Gallery (Phase 28). Migrates legacy cmsRenderGallery()/
 * cmsAddGalleryImage()/cmsLoadGalleryList()/cmsToggleGalleryActive()/
 * cmsDeleteGalleryRow() — same /api/settings/gallery... contract.
 */
export default function CmsGalleryTab({ cms }) {
  const tab = cms.tabs.gallery;
  const toast = useToast();
  const imageRef = useRef(null);
  const [caption, setCaption] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  async function handleAdd() {
    const image = imageRef.current?.files?.[0];
    if (!image) {
      setAddError("Please choose an image.");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await cms.addGalleryImage({ image, caption: caption.trim() });
      setCaption("");
      if (imageRef.current) imageRef.current.value = "";
      toast.success("Photo added.");
    } catch (e) {
      setAddError(e.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleToggle(g) {
    try {
      await cms.toggleGalleryActive(g.id, !g.active);
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <CmsTabState tab={tab} loadingLabel="Loading gallery…" forbiddenDescription="Landing Page CMS is limited to administrators." onRetry={() => cms.reload("gallery")}>
      {(data) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card>
            <CardHeader title="Add photo" />
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <FormField label="Image">
                <input ref={imageRef} type="file" accept="image/*" />
              </FormField>
              <FormField label="Caption (optional)">
                <Input value={caption} onChange={(e) => setCaption(e.target.value)} />
              </FormField>
              {addError && <p style={{ color: "var(--danger, #dc2626)", margin: 0 }}>{addError}</p>}
              <div>
                <Button onClick={handleAdd} loading={adding}>
                  Add photo
                </Button>
              </div>
            </div>
          </Card>

          <Card padding={false}>
            <DataTable
              columns={[
                {
                  key: "photo",
                  header: "Photo",
                  render: (g) => (
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <img src={g.image_path} alt="" style={{ width: 44, height: 44, borderRadius: 6, objectFit: "cover" }} />
                      {g.caption || ""}
                    </span>
                  ),
                },
                { key: "status", header: "Status", render: (g) => <Badge tone={g.active ? "success" : "neutral"}>{g.active ? "Visible" : "Hidden"}</Badge> },
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  render: (g) => (
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <Button variant="ghost" size="sm" onClick={() => handleToggle(g)}>
                        {g.active ? "Hide" : "Show"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(g)}>
                        Delete
                      </Button>
                    </div>
                  ),
                },
              ]}
              rows={data.images}
              getRowKey={(g) => g.id}
              emptyState={<div style={{ padding: 24, color: "var(--text-muted, #6b7280)" }}>No photos yet.</div>}
            />
          </Card>

          <ConfirmationDialog
            open={!!deleteTarget}
            onClose={() => setDeleteTarget(null)}
            title="Delete photo?"
            confirmLabel="Delete"
            confirmVariant="danger"
            onConfirm={async () => {
              try {
                await cms.removeGalleryImage(deleteTarget.id);
              } catch (e) {
                toast.error(e.message);
              }
            }}
          >
            This photo will be removed from the gallery. This can't be undone.
          </ConfirmationDialog>
        </div>
      )}
    </CmsTabState>
  );
}
