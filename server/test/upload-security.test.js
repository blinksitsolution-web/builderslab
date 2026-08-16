/**
 * Pure-logic regression tests for server/src/middleware/upload.js.
 *
 * These exercise the actual exported functions (fileFilterForProfile,
 * verifyUploadedFile, safeExt) directly — no Express/multer instance is
 * booted, so these run with zero extra dependencies via `node --test`.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const upload = require("../src/middleware/upload");

function runFilter(profile, filename, mimetype) {
  const filter = upload.fileFilterForProfile(profile);
  let result = null;
  filter({}, { originalname: filename, mimetype }, (err, ok) => {
    result = { err, ok };
  });
  return result;
}

function withTempFile(name, buffer, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-test-"));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, buffer);
  try {
    return fn(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runVerify(profile, filePath, originalname) {
  const middleware = upload.verifyUploadedFile(profile);
  const req = { file: { path: filePath, originalname } };
  let statusCode = null;
  let responseBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, statusCode, responseBody, stillExists: fs.existsSync(filePath) };
}

// Real magic bytes for each format under test.
const REAL_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(20)]);
const REAL_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(20)]);
const REAL_WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(10)]);
const REAL_PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(20)]);
const REAL_DOCX = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.alloc(20)]); // zip container (OOXML)

test("upload-security: valid files pass content verification", async (t) => {
  await t.test("PNG", () => {
    withTempFile("a.png", REAL_PNG, (p) => {
      const r = runVerify("IMAGE", p, "a.png");
      assert.equal(r.nextCalled, true);
      assert.equal(r.stillExists, true);
    });
  });
  await t.test("JPEG", () => {
    withTempFile("a.jpg", REAL_JPEG, (p) => {
      const r = runVerify("IMAGE", p, "a.jpg");
      assert.equal(r.nextCalled, true);
    });
  });
  await t.test("WebP", () => {
    withTempFile("a.webp", REAL_WEBP, (p) => {
      const r = runVerify("IMAGE", p, "a.webp");
      assert.equal(r.nextCalled, true);
    });
  });
  await t.test("PDF", () => {
    withTempFile("a.pdf", REAL_PDF, (p) => {
      const r = runVerify("DOCUMENT", p, "a.pdf");
      assert.equal(r.nextCalled, true);
    });
  });
  await t.test("DOCX (Office/OOXML)", () => {
    withTempFile("a.docx", REAL_DOCX, (p) => {
      const r = runVerify("DOCUMENT", p, "a.docx");
      assert.equal(r.nextCalled, true);
    });
  });
});

test("upload-security: rejected files are blocked and not left on disk", async (t) => {
  await t.test("executable/script content disguised as an allowed image extension is rejected + deleted", () => {
    const phpPayload = Buffer.from("<?php system($_GET['c']); ?>");
    withTempFile("fake.png", phpPayload, (p) => {
      const r = runVerify("IMAGE", p, "fake.png");
      assert.equal(r.nextCalled, false);
      assert.equal(r.statusCode, 400);
      assert.equal(r.stillExists, false, "rejected file must be deleted, not left behind");
    });
  });

  await t.test("HTML/script payload disguised as an allowed document extension is rejected + deleted", () => {
    const htmlPayload = Buffer.from("<html><body><script>alert(document.cookie)</script></body></html>");
    withTempFile("fake.pdf", htmlPayload, (p) => {
      const r = runVerify("DOCUMENT", p, "fake.pdf");
      assert.equal(r.nextCalled, false);
      assert.equal(r.statusCode, 400);
      assert.equal(r.stillExists, false);
    });
  });

  await t.test("MIME/content mismatch: real PDF bytes saved with a .png extension is rejected", () => {
    withTempFile("mismatch.png", REAL_PDF, (p) => {
      const r = runVerify("IMAGE", p, "mismatch.png");
      assert.equal(r.nextCalled, false);
      assert.equal(r.statusCode, 400);
      assert.equal(r.stillExists, false);
    });
  });

  await t.test("invalid/unknown file signature (random bytes with an allowed extension) is rejected", () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    withTempFile("garbage.png", garbage, (p) => {
      const r = runVerify("IMAGE", p, "garbage.png");
      assert.equal(r.nextCalled, false);
      assert.equal(r.statusCode, 400);
      assert.equal(r.stillExists, false);
    });
  });

  await t.test("SVG is rejected outright (fileFilter), even with an image mimetype", () => {
    const r = runFilter("IMAGE", "logo.svg", "image/svg+xml");
    assert.notEqual(r.ok, true);
  });

  await t.test("SVG containing an inline script is rejected outright (fileFilter), never reaches content verification", () => {
    const r = runFilter("IMAGE", "evil.svg", "image/svg+xml");
    assert.notEqual(r.ok, true);
    // Confirm SVG is on the permanent extension blocklist, not just an
    // accident of the current IMAGE profile's allowlist.
    assert.equal(upload.DANGEROUS_EXTENSIONS.has("svg"), true);
  });

  await t.test("spoofed MIME type cannot bypass validation (fileFilter catches obvious spoofing; verify catches the rest)", () => {
    // A PHP file relabeled with an image mimetype is rejected by fileFilter
    // purely on its dangerous extension, regardless of the (spoofed) mimetype.
    const filterResult = runFilter("IMAGE", "shell.php", "image/png");
    assert.notEqual(filterResult.ok, true);
  });

  await t.test("path traversal-style original filename cannot control the stored path", () => {
    // safeExt only ever extracts the extension; the directory-traversal
    // portion of the name is never used to build a path.
    assert.equal(upload.safeExt("../../../../etc/passwd.png"), "png");
    assert.equal(upload.safeExt("..\\..\\windows\\system32\\evil.jpg"), "jpg");

    withTempFile("safe.png", REAL_PNG, (p) => {
      const r = runVerify("IMAGE", p, "../../../../etc/passwd.png");
      // Verification only inspects the extension + real file content; a
      // traversal-style original name has no special effect either way.
      assert.equal(r.nextCalled, true);
    });
  });

  await t.test("executable extensions are rejected across every profile", () => {
    for (const profile of Object.keys(upload.PROFILES)) {
      const r = runFilter(profile, "malware.exe", "application/octet-stream");
      assert.notEqual(r.ok, true, `profile ${profile} must reject .exe`);
    }
  });
});
