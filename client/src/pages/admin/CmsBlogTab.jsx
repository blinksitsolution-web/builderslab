import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, Button, Badge, DataTable, Modal, FormField, Input, Textarea, Checkbox, ConfirmationDialog } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import CmsTabState from "./CmsTabState";

/**
 * News / Blog (Phase 28). Migrates legacy settingsBlog()/addBlogPost()/
 * loadBlogList()/toggleBlogPublished()/openBlogEditModal()/
 * saveBlogEdit()/removeBlogPost() — same /api/settings/blog... contract.
 */
export default function CmsBlogTab({ cms }) {
  const tab = cms.tabs.blog;
  const toast = useToast();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState("");
  const [author, setAuthor] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [featured, setFeatured] = useState(false);
  const coverRef = useRef(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState(null);

  const [editorPost, setEditorPost] = useState(undefined); // undefined = closed, object = edit
  const [deleteTarget, setDeleteTarget] = useState(null);

  async function handlePublish() {
    if (!title.trim() || !body.trim()) {
      setPublishError("Title and body are required.");
      return;
    }
    setPublishing(true);
    setPublishError(null);
    try {
      await cms.addBlogPost({
        title: title.trim(),
        body: body.trim(),
        cover: coverRef.current?.files?.[0] || null,
        category: category.trim(),
        author: author.trim(),
        videoUrl: videoUrl.trim(),
        featured,
      });
      setTitle("");
      setBody("");
      setCategory("");
      setAuthor("");
      setVideoUrl("");
      setFeatured(false);
      if (coverRef.current) coverRef.current.value = "";
      toast.success("Post published.");
    } catch (e) {
      setPublishError(e.message);
    } finally {
      setPublishing(false);
    }
  }

  async function handleTogglePublished(p) {
    try {
      await cms.toggleBlogPublished(p.id, !p.published);
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <CmsTabState tab={tab} loadingLabel="Loading news / blog posts…" forbiddenDescription="Landing Page CMS is limited to administrators." onRetry={() => cms.reload("blog")}>
      {(data) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card>
            <CardHeader title="Post news / blog update" />
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <FormField label="Title">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} />
              </FormField>
              <FormField label="Body">
                <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
              </FormField>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FormField label="Category">
                  <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Announcements, Events" />
                </FormField>
                <FormField label="Author">
                  <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="e.g. Dalijay Tech Hub" />
                </FormField>
              </div>
              <FormField label="Video URL (optional)">
                <Input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://youtube.com/…" />
              </FormField>
              <FormField label="Cover image (optional)">
                <input ref={coverRef} type="file" accept="image/*" />
              </FormField>
              <Checkbox label="Feature this on the Landing Page" checked={featured} onChange={(e) => setFeatured(e.target.checked)} />
              {publishError && <p style={{ color: "var(--danger, #dc2626)", margin: 0 }}>{publishError}</p>}
              <div>
                <Button onClick={handlePublish} loading={publishing}>
                  Publish
                </Button>
              </div>
            </div>
          </Card>

          <Card padding={false}>
            <DataTable
              columns={[
                {
                  key: "title",
                  header: "Title",
                  render: (p) => (
                    <span>
                      {p.featured && (
                        <Badge tone="brand" className="cms-blog-featured-badge">
                          ★
                        </Badge>
                      )}{" "}
                      {p.title}
                      {p.category && <div style={{ color: "var(--text-muted, #6b7280)", fontSize: 12 }}>{p.category}</div>}
                    </span>
                  ),
                },
                { key: "date", header: "Date", render: (p) => (p.date || "").slice(0, 10) },
                {
                  key: "status",
                  header: "Status",
                  render: (p) => <Checkbox label="Published" checked={!!p.published} onChange={() => handleTogglePublished(p)} />,
                },
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  render: (p) => (
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <Button variant="ghost" size="sm" onClick={() => setEditorPost(p)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(p)}>
                        Remove
                      </Button>
                    </div>
                  ),
                },
              ]}
              rows={data.posts}
              getRowKey={(p) => p.id}
              emptyState={<div style={{ padding: 24, color: "var(--text-muted, #6b7280)" }}>None yet.</div>}
            />
          </Card>

          <BlogEditModal post={editorPost} open={editorPost !== undefined} onClose={() => setEditorPost(undefined)} onSave={cms.saveBlogPost} />

          <ConfirmationDialog
            open={!!deleteTarget}
            onClose={() => setDeleteTarget(null)}
            title="Remove post?"
            confirmLabel="Remove"
            confirmVariant="danger"
            onConfirm={async () => {
              try {
                await cms.removeBlogPost(deleteTarget.id);
              } catch (e) {
                toast.error(e.message);
              }
            }}
          >
            Remove "{deleteTarget?.title}"? This can't be undone.
          </ConfirmationDialog>
        </div>
      )}
    </CmsTabState>
  );
}

function BlogEditModal({ post, open, onClose, onSave }) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState("");
  const [author, setAuthor] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [featured, setFeatured] = useState(false);
  const coverRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setTitle(post?.title || "");
    setBody(post?.body || "");
    setCategory(post?.category || "");
    setAuthor(post?.author || "");
    setVideoUrl(post?.video_url || "");
    setFeatured(!!post?.featured);
    setFormError(null);
    if (coverRef.current) coverRef.current.value = "";
  }, [open, post]);

  async function handleSave() {
    setSaving(true);
    setFormError(null);
    try {
      await onSave(post.id, {
        title: title.trim(),
        body: body.trim(),
        category: category.trim(),
        author: author.trim(),
        videoUrl: videoUrl.trim(),
        featured,
        cover: coverRef.current?.files?.[0] || null,
      });
      onClose();
      toast.success("Post updated.");
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit news post"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            Save changes
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <FormField label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormField>
        <FormField label="Body">
          <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </FormField>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <FormField label="Category">
            <Input value={category} onChange={(e) => setCategory(e.target.value)} />
          </FormField>
          <FormField label="Author">
            <Input value={author} onChange={(e) => setAuthor(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Video URL">
          <Input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} />
        </FormField>
        <FormField label="Replace cover image (optional)">
          <input ref={coverRef} type="file" accept="image/*" />
        </FormField>
        {post?.cover_path && <img src={post.cover_path} alt="" style={{ width: 100, borderRadius: 8 }} />}
        <Checkbox label="Feature this on the Landing Page" checked={featured} onChange={(e) => setFeatured(e.target.checked)} />
        {formError && <p style={{ color: "var(--danger, #dc2626)", margin: 0 }}>{formError}</p>}
      </div>
    </Modal>
  );
}
