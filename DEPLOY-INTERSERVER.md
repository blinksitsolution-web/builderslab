# Deploy The Builders' Lab on InterServer (cPanel)

Complete guide for **builderslab.dalijaytechhub.com** when:

- **Domain DNS** is managed at **Hostinger**
- **Hosting** is on **InterServer** shared hosting (cPanel + Node.js)

Estimated time: 45–90 minutes the first time.

---

## Overview

| Piece | What you use |
|-------|----------------|
| Live URL | `https://builderslab.dalijaytechhub.com` |
| App type | Node.js (Express) — **not** PHP |
| Database | **SQLite file** (`server/data/builderslab.db`) — **not** MySQL |
| Frontend | Pre-built React app in `client/dist/` (included in upload) |
| Process manager | cPanel **Setup Node.js App** (not PM2 on shared hosting) |

---

## Part 1 — DNS at Hostinger (point subdomain to InterServer)

Your main domain `dalijaytechhub.com` stays on Hostinger. Only the **subdomain** `builderslab` will point to InterServer.

### 1.1 Get your InterServer server IP

1. Log in to **InterServer cPanel**.
2. On the right sidebar, find **Shared IP Address** (or **Dedicated IP**).
3. Copy that IP (example: `199.123.45.67`).

### 1.2 Add DNS record at Hostinger

1. Log in to **Hostinger** → **Domains** → **dalijaytechhub.com** → **DNS / DNS Zone**.
2. Add a new record:

| Type | Name / Host | Points to | TTL |
|------|-------------|-----------|-----|
| **A** | `builderslab` | Your InterServer IP from step 1.1 | 300 or default |

3. Save. DNS can take **5 minutes to 48 hours** to propagate (often under 1 hour).

### 1.3 Verify DNS (optional, after a few minutes)

On your computer:

```bash
nslookup builderslab.dalijaytechhub.com
```

The answer should show your **InterServer IP**.

---

## Part 2 — Add the subdomain in InterServer cPanel

Because the parent domain is registered elsewhere, add the full hostname as an **addon domain** or **subdomain** in InterServer.

1. InterServer cPanel → **Domains** → **Create A New Domain** or **Subdomains**.
2. Domain: `builderslab.dalijaytechhub.com`
3. Document root: note the folder path (example: `/home/youruser/builderslab.dalijaytechhub.com`). You will upload files here or in a folder you choose — **keep the path consistent** with Part 4.
4. Save.

> **SSL:** After DNS works, enable **AutoSSL** or **Let's Encrypt** in cPanel for `builderslab.dalijaytechhub.com` ( **SSL/TLS Status** ). HTTPS is **required** for login cookies and Paystack.

---

## Part 3 — Prepare files on your computer

### 3.1 What to upload

Upload the **entire project**, keeping this structure:

```
builderslab/                          ← project root on server
├── client/
│   └── dist/                         ← REQUIRED (pre-built React app)
├── images/
└── server/                           ← Node.js application root
    ├── src/server.js                 ← startup file
    ├── package.json
    ├── .env                          ← create on server (see Part 5)
    ├── data/                         ← SQLite lives here
    └── uploads/                      ← user uploads
```

### 3.2 What NOT to upload

| Skip | Why |
|------|-----|
| `server/node_modules/` | Install on server with **Run NPM Install** |
| `client/node_modules/` | Not needed in production |
| Your local `server/.env` with dev secrets | Create production `.env` on server |
| `server/test/`, log files | Optional; saves space |

### 3.3 Create a ZIP (recommended)

1. Zip the project folder (excluding `node_modules` if possible).
2. Upload via cPanel **File Manager** → extract in your chosen directory (e.g. `/home/youruser/builderslab`).

---

## Part 4 — Upload to InterServer

1. cPanel → **File Manager**.
2. Go to `/home/youruser/` (or the document root from Part 2).
3. Create folder `builderslab` if needed.
4. **Upload** your ZIP → **Extract**.
5. Confirm these exist:
   - `builderslab/client/dist/index.html`
   - `builderslab/server/package.json`
   - `builderslab/server/src/server.js`

### 4.1 Set folder permissions

In File Manager, set permissions (right-click → **Change Permissions**):

| Path | Permission |
|------|------------|
| `server/data/` | **755** or **775** (must be writable by Node) |
| `server/uploads/` | **755** or **775** |
| `server/data/backups/` | **755** or **775** |

If the app cannot create the database, try **775** on `server/data/`.

---

## Part 5 — Configure environment (`.env`)

The app uses a **SQLite file**, not cPanel MySQL. You do **not** need to create a MySQL database in cPanel.

### 5.1 Create `server/.env`

1. In File Manager, open `builderslab/server/`.
2. Copy `.env.production.example` → rename to `.env`
3. Edit `.env`:

```env
NODE_ENV=production
APP_URL=https://builderslab.dalijaytechhub.com

JWT_SECRET=66f938cae9a803bf3b2ed2755a3ee8c7409698291c1ad17383c5738d9a6a57bb38cae357d887d6396551347835c02e79
AI_CREDENTIALS_KEY=b67f930b98f9685648ac8fdec12b8a1598d06c70b5c1ed5821196ed126a42a39a6f0558d87e28838ae6fb64d3271c
COOKIE_SECURE=true

ADMIN_NAME=Your Name
ADMIN_EMAIL=admin@dalijaytechhub.com
ADMIN_PASSWORD=<strong-password-you-will-use>
ADMIN_PHONE=233XXXXXXXXX

PAYSTACK_SECRET_KEY=sk_test_...   # or sk_live_ when ready
REGISTRATION_FEE_GHS=350
MONTHLY_FEE_GHS=180
```

### 5.2 Generate secrets (on your PC or via SSH)

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Run twice — once for `JWT_SECRET`, once for `AI_CREDENTIALS_KEY`.

> **Important:** `APP_URL` must be exactly `https://builderslab.dalijaytechhub.com` — no trailing slash, must match your live URL.

---

## Part 6 — Create the Node.js app in cPanel

1. cPanel → **Software** → **Setup Node.js App**.
2. Click **Create Application**.

| Field | Value |
|-------|--------|
| **Node.js version** | **20.x** or latest available (minimum 20) |
| **Application mode** | **Production** |
| **Application root** | Path to **`server`** folder, e.g. `/home/youruser/builderslab/server` |
| **Application URL** | `builderslab.dalijaytechhub.com` |
| **Application startup file** | `src/server.js` |

3. Click **Create**.

### 6.1 Install dependencies

On the same Node.js app page:

1. Click **Run NPM Install** (or via SSH below).
2. Wait until it finishes without errors.

**If `better-sqlite3` fails:** open a ticket with InterServer or use SSH:

```bash
source /home/youruser/nodevenv/builderslab/server/20/bin/activate   # path varies — copy from cPanel Node.js page
cd ~/builderslab/server
npm install
```

### 6.2 Add environment variables in cPanel (optional)

You can paste the same variables from `.env` into the **Environment variables** section on the Node.js app page instead of using a file. If both are set, ensure they **match**. Using `server/.env` alone is fine.

### 6.3 Do NOT set PORT manually

cPanel/Passenger assigns `PORT` automatically. Leave it unset unless InterServer support tells you otherwise.

### 6.4 Start / restart the app

Click **Restart** on the Node.js app page.

---

## Part 7 — Create the database (SQLite)

SSH is the easiest way. In cPanel → **Terminal** (or your own SSH client):

```bash
cd ~/builderslab/server

# Activate the same Node environment cPanel shows on the Node.js app page:
# Example (your path may differ):
source /home/youruser/nodevenv/builderslab/server/20/bin/activate

# Pre-flight checks
npm run verify:deploy

# Create / update database schema (safe to re-run)
npm run migrate

# First-time only — create admin account from ADMIN_* in .env
npm run seed:admin
```

### If you already have a production database

Instead of a fresh migrate:

1. Upload your existing `builderslab.db` to `server/data/builderslab.db`.
2. Still run `npm run migrate` once (adds new columns safely).
3. Skip `seed:admin` unless you need a new admin.

---

## Part 8 — Verify the site works

### 8.1 Health checks

In a browser or terminal:

```text
https://builderslab.dalijaytechhub.com/api/health
→ {"status":"ok"}

https://builderslab.dalijaytechhub.com/api/ready
→ {"status":"ready"}
```

If `/api/ready` returns `503`, read the `problems` array — usually missing `.env` values or database not created.

### 8.2 Manual browser tests

| URL | Expected |
|-----|----------|
| `https://builderslab.dalijaytechhub.com/` | Public landing page |
| `https://builderslab.dalijaytechhub.com/app/login` | Login page |
| Log in with admin email/password | Admin dashboard |

### 8.3 Common problems

| Symptom | Fix |
|---------|-----|
| **503** on subdomain | Node app not running — Restart in Setup Node.js App; check error log on that page |
| **Blank page** | `client/dist/` missing or wrong upload path |
| **Login fails / instant logout** | `APP_URL` wrong, or `COOKIE_SECURE=true` without HTTPS — fix SSL first |
| **Cannot write database** | Fix permissions on `server/data/` |
| **`better-sqlite3` error** | Re-run `npm install` inside the cPanel Node virtualenv |
| **CORS / auth errors** | `APP_URL` must exactly match `https://builderslab.dalijaytechhub.com` |

---

## Part 9 — Paystack webhook

1. Log in to [Paystack Dashboard](https://dashboard.paystack.com) → **Settings** → **Webhooks**.
2. Add URL:

```text
https://builderslab.dalijaytechhub.com/api/payments/webhook
```

3. Save. Test a small payment after going live.

---

## Part 10 — Backups (recommended)

In cPanel → **Cron Jobs**, add (adjust username and path):

```cron
0 3 * * * cd /home/youruser/builderslab/server && /home/youruser/nodevenv/builderslab/server/20/bin/node src/db/backup.js
30 3 * * * cd /home/youruser/builderslab/server && /home/youruser/nodevenv/builderslab/server/20/bin/node src/db/backupUploads.js
```

Copy the Node binary path from your **Setup Node.js App** page.

Backups are stored in `server/data/backups/`. Download them periodically via File Manager or FTP.

---

## Part 11 — Updating the app later

1. Upload changed files (keep `server/data/` and `server/uploads/`).
2. If `client/` changed: rebuild locally (`cd client && npm run build`) and upload new `client/dist/`.
3. SSH or cPanel Terminal:

```bash
cd ~/builderslab/server
source /home/youruser/nodevenv/builderslab/server/20/bin/activate
npm run migrate
npm run verify:deploy
```

4. cPanel → **Setup Node.js App** → **Restart**.

---

## Quick reference

| Item | Value |
|------|--------|
| Site URL | `https://builderslab.dalijaytechhub.com` |
| App login | `https://builderslab.dalijaytechhub.com/app/login` |
| Admin (after seed) | Email/password from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env` |
| Database file | `server/data/builderslab.db` |
| Startup file | `server/src/server.js` |
| Env template | `server/.env.production.example` |
| Verify command | `npm run verify:deploy` (inside `server/`) |

---

## Need help?

1. cPanel → **Setup Node.js App** → view **stderr** log for startup errors.
2. Run `npm run verify:deploy` and fix any **FAIL** lines.
3. Confirm DNS: `builderslab.dalijaytechhub.com` → InterServer IP.
4. Confirm SSL certificate is active for the subdomain.
