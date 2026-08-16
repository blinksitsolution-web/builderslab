import { apiGet, apiPost, ApiError } from "./client";

// GET .../learning-instances — Part 1's "select an active Learning
// Instance" picker.
export async function fetchBulkRegistrationLearningInstances(sponsorId) {
  return apiGet(`/api/sponsors/${sponsorId}/bulk-registration/learning-instances`);
}

// Server-generated .xlsx downloads (template + report) aren't JSON, so
// they go through a plain authenticated fetch rather than apiRequest —
// mirrors the same credentials:"include", same-origin convention, just
// with a Blob response instead of JSON.
async function downloadFile(url, fallbackFilename) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // not JSON — keep the generic message
    }
    throw new ApiError(message, { status: res.status });
  }
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = (match && match[1]) || fallbackFilename;
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

export function downloadBulkRegistrationTemplate(sponsorId, learningInstanceId) {
  return downloadFile(`/api/sponsors/${sponsorId}/bulk-registration/template?learningInstanceId=${learningInstanceId}`, "bulk-registration-template.xlsx");
}

export function downloadBulkRegistrationReport(sponsorId, batchId) {
  return downloadFile(`/api/sponsors/${sponsorId}/bulk-registration/${batchId}/report`, "bulk-registration-report.xlsx");
}

// POST .../validate (multipart) — Parts 2 & 3: validation report +
// registration preview (priced by the constitutional Pricing Engine).
export async function uploadAndValidateBulkRegistration(sponsorId, { learningInstanceId, file }) {
  const form = new FormData();
  form.append("learningInstanceId", learningInstanceId);
  form.append("file", file);
  return apiPost(`/api/sponsors/${sponsorId}/bulk-registration/validate`, form, { isForm: true });
}

export async function fetchBulkRegistrationBatch(sponsorId, batchId) {
  return apiGet(`/api/sponsors/${sponsorId}/bulk-registration/${batchId}`);
}

// POST .../:batchId/commit — Parts 4, 5 & 7. Idempotent: safe to call
// again on an already-committed batch (returns the same result).
export async function commitBulkRegistrationBatch(sponsorId, batchId) {
  return apiPost(`/api/sponsors/${sponsorId}/bulk-registration/${batchId}/commit`, {});
}
