# Deploy The Builders' Lab on Railway (Free Tier)

Complete step-by-step guide for deploying to **railway.app** — free tier,
persistent storage, Node 20, no GLIBC issues.

**Live URL after deploy:** `https://builderslab.up.railway.app` (or your
custom subdomain `builderslab.dalijaytechhub.com` pointed at Railway).

---

## Overview

| Piece | What you use |
|-------|--------------|
| Platform | Railway (free $5/month credit) |
| Runtime | Node.js 20 (full Linux, no restrictions) |
| Database | SQLite on a Railway persistent volume |
| Frontend | Pre-built React app in `client/dist/` (built during deploy) |
| DNS | Hostinger — point subdomain to Railway |

---

## Part 1 — Push code to GitHub

### 1.1 Install Git (if not already installed)
Download from https://git-scm.com and install with default options.

### 1.2 Open a terminal in the project root

On Windows, open **Command Prompt** or **PowerShell** in:
```
C:\Users\BLINKS IT SOLUTION\Downloads\builderslab_audit-trail
```

### 1.3 Initialize and push

```bash
git init
git remote add origin https://github.com/blinksitsolution-web/builderslab.git
git add .
git commit -m "Initial production deployment"
git branch -M main
git push -u origin main
```

If prompted, sign in to GitHub.

> **Note:** `node_modules/`, `.env`, `builderslab.db`, and user uploads are
> excluded by `.gitignore` — only source code is pushed.

---

## Part 2 — Create Railway account and project

1. Go to **https://railway.app** and sign up with your GitHub account.
2. Click **New Project** → **Deploy from GitHub repo**.
3. Select **blinksitsolution-web/builderslab**.
4. Railway will detect the `nixpacks.toml` and start building automatically.
   The first build takes 3–5 minutes (installs deps + builds React app).

---

## Part 3 — Add a persistent volume (critical — do this before first deploy completes)

Without a volume, the SQLite database and uploads are wiped on every redeploy.

1. In your Railway project, click your **service** (the builderslab service).
2. Go to **Settings** → **Volumes** → **Add Volume**.
3. Set:
   - **Mount Path:** `/app/data`
   - **Size:** 1 GB (free)
4. Click **Add**.
5. Add a **second volume** for uploads:
   - **Mount Path:** `/app/uploads`
   - **Size:** 1 GB (free)
6. Railway will redeploy automatically after adding volumes.

---

## Part 4 — Set environment variables

In Railway → your service → **Variables** tab, add each of these:

| Variable | Value |
|----------|-------|
| `NODE_ENV` | `production` |
| `APP_URL` | `https://builderslab.up.railway.app` (your Railway URL — copy from Settings → Domains) |
| `DB_PATH` | `/app/data/builderslab.db` |
| `UPLOAD_DIR` | `/app/uploads` |
| `JWT_SECRET` | Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `AI_CREDENTIALS_KEY` | Generate same way as above (run twice, use different value) |
| `JWT_EXPIRES_IN` | `30d` |
| `COOKIE_SECURE` | `true` |
| `ADMIN_NAME` | Your name |
| `ADMIN_EMAIL` | Your admin email |
| `ADMIN_PASSWORD` | A strong password |
| `ADMIN_PHONE` | `233XXXXXXXXX` |
| `PAYSTACK_SECRET_KEY` | Your Paystack secret key |
| `REGISTRATION_FEE_GHS` | `350` |
| `MONTHLY_FEE_GHS` | `180` |

> **Important:** After setting `APP_URL`, Railway will redeploy. Wait for it
> to finish before continuing.

---

## Part 5 — Run database migration and seed admin

Once the deploy is green (✅):

1. In Railway → your service → **Deploy** tab → click **Open Shell** (or use
   the Railway CLI).
2. Run:

```bash
npm run migrate
npm run seed:admin
```

You should see:
```
✅ Database migrated at /app/data/builderslab.db
✅ Admin account created: admin@dalijaytechhub.com
```

---

## Part 6 — Verify the deployment

In your browser:

```
https://builderslab.up.railway.app/api/health
→ {"status":"ok"}

https://builderslab.up.railway.app/api/ready
→ {"status":"ready"}

https://builderslab.up.railway.app/
→ Landing page loads

https://builderslab.up.railway.app/app/login
→ Login page loads
```

Log in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` you set.

---

## Part 7 — Point your Hostinger subdomain to Railway (optional)

To use `https://builderslab.dalijaytechhub.com` instead of the Railway URL:

### 7.1 Get your Railway domain

In Railway → your service → **Settings** → **Domains** → **Add Custom Domain**:
- Enter: `builderslab.dalijaytechhub.com`
- Railway will show you a **CNAME target** (e.g. `builderslab.up.railway.app`)

### 7.2 Add DNS record at Hostinger

1. Log in to Hostinger → **Domains** → **dalijaytechhub.com** → **DNS Zone**.
2. Add a new record:

| Type | Name | Points to | TTL |
|------|------|-----------|-----|
| **CNAME** | `builderslab` | `builderslab.up.railway.app` | 300 |

3. Save. DNS propagates in 5–30 minutes.

### 7.3 Update APP_URL

In Railway → Variables, update:
```
APP_URL=https://builderslab.dalijaytechhub.com
```

Railway will redeploy automatically. Railway also provisions SSL automatically
for custom domains — no manual certificate setup needed.

---

## Part 8 — Paystack webhook

In Paystack Dashboard → Settings → Webhooks, set:
```
https://builderslab.dalijaytechhub.com/api/payments/webhook
```

---

## Part 9 — Updating the app later

1. Make changes locally.
2. Push to GitHub:
```bash
git add .
git commit -m "describe your change"
git push
```
3. Railway detects the push and redeploys automatically.
4. If you changed the database schema, open Railway Shell and run:
```bash
npm run migrate
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Build fails | Check Railway build logs — usually a missing env var or npm install error |
| App crashes on start | Check Railway deploy logs — usually `APP_URL` not set or `DB_PATH` wrong |
| `/api/ready` returns 503 | Run `npm run migrate` in Railway Shell |
| Login fails / instant logout | `APP_URL` must exactly match the URL you're accessing |
| Uploads not persisting | Confirm `/app/uploads` volume is mounted and `UPLOAD_DIR=/app/uploads` is set |
| Database wiped after redeploy | Confirm `/app/data` volume is mounted and `DB_PATH=/app/data/builderslab.db` is set |

---

## Quick reference

| Item | Value |
|------|-------|
| Railway dashboard | https://railway.app |
| App URL | https://builderslab.dalijaytechhub.com (or Railway URL) |
| Login | https://builderslab.dalijaytechhub.com/app/login |
| Health check | https://builderslab.dalijaytechhub.com/api/health |
| Ready check | https://builderslab.dalijaytechhub.com/api/ready |
| DB path (on server) | `/app/data/builderslab.db` |
| Uploads path (on server) | `/app/uploads` |
| Env template | `server/.env.railway.example` |
