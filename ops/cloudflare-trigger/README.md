# Cloudflare Worker: the 30-minute refresh trigger

## Why this exists

The "Refresh current conditions" workflow is meant to run every 30 minutes. GitHub runs scheduled workflows on a best-effort basis and, on this quiet repository, fired ours only every three to five hours during the first two days (see `ARCHITECTURE.md`, Scheduling and deploy). The workflow also has a `workflow_dispatch` hook, which runs it on demand, to the minute, when something calls GitHub's API. This Worker is that something: a Cloudflare cron trigger at 7 and 37 minutes past each hour that makes one API call.

**Cost: zero.** Cloudflare's free Workers plan includes cron triggers and 100,000 requests a day; this uses 48. GitHub Actions minutes are free on public repositories. The schedule inside the workflow stays as a fallback; when GitHub does honour it at the same minute, the second run just waits for the first (the `pages` concurrency group) and finishes a minute later.

**What the token can do:** run or cancel Actions workflows on `cabinradio/cabin-weather`, and nothing else, on no other repository. It lives only as a secret inside the Worker, never in this repository.

## Step 1 – create the GitHub token (about 3 minutes)

1. On github.com, signed in as `cabinradio`, open the top-right profile menu → **Settings**.
2. Left sidebar, bottom: **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
3. Fill in:
   - **Token name:** `cabin-weather-trigger`
   - **Expiration:** choose **Custom** and pick a date one year out. Write that date in the "Renewal" section at the bottom of this file.
   - **Repository access:** **Only select repositories** → choose `cabin-weather`.
   - **Permissions → Repository permissions → Actions:** **Read and write**. Leave everything else at No access (Metadata becomes Read automatically).
4. **Generate token**. Copy it now; GitHub shows it once. Keep it somewhere safe until step 2 is done, then delete that copy.

## Step 2 – create the Worker in the Cloudflare dashboard (about 5 minutes)

1. Sign in to dash.cloudflare.com → left sidebar **Workers & Pages** → **Create** (or **Create application**) → **Create Worker**.
2. Name it `cabin-weather-trigger` and click **Deploy** (it deploys a hello-world first; that is fine).
3. Click **Edit code**. Select everything in the editor, delete it, and paste the whole of `worker.js` from this folder. Click **Deploy** (top right).
4. Go back to the Worker's page → **Settings** → **Variables and Secrets** → **Add**:
   - **Type:** Secret
   - **Variable name:** `GITHUB_TOKEN`
   - **Value:** the token from step 1
   - **Deploy** (or **Save and deploy**).
5. Still in **Settings** → **Triggers** → **Cron Triggers** → **Add Cron Trigger**. Choose the custom/cron expression option and enter exactly:

   ```
   7,37 * * * *
   ```

   Save. The dashboard shows the next few run times; they should be at :07 and :37 UTC.

That is the whole setup. The Worker's public URL (something like `cabin-weather-trigger.<your-subdomain>.workers.dev`) only prints one line if visited; it does not trigger anything.

## Step 3 – confirm it works

Wait for the next :07 or :37 past the hour (UTC), then either:

- open https://github.com/cabinradio/cabin-weather/actions/workflows/refresh-current.yml and look for a run whose trigger says **workflow_dispatch** (the scheduled ones say **schedule**), or
- in a terminal in the repo:

  ```bash
  gh run list --workflow "Refresh current conditions" --limit 10
  ```

  and look for `workflow_dispatch` rows every 30 minutes.

If nothing appears within an hour: in Cloudflare, open the Worker → **Logs** (or **Observability**) and look for an error. "HTTP 401" means the token was pasted wrongly or has expired; "HTTP 403" or "HTTP 404" means the token does not have Actions: read and write on this repository.

## Alternative: deploy with the wrangler CLI

```bash
cd ops/cloudflare-trigger
npx wrangler login
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

`wrangler.toml` carries the cron trigger. To test the scheduled handler locally: `npx wrangler dev --test-scheduled`, then in another terminal `curl "http://localhost:8787/__scheduled?cron=7,37+*+*+*+*"`.

## Renewal

Fine-grained tokens expire. When this one does, the Worker starts failing with HTTP 401 and the refresh falls back to GitHub's own schedule, so the page keeps working but goes stale for hours at a time.

- Token created: __________ Expires: __________
- To renew: repeat step 1 (GitHub lets you regenerate the same token), then in Cloudflare replace the `GITHUB_TOKEN` secret value and deploy.
