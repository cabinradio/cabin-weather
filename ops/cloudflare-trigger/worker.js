// Cabin Weather refresh trigger.
//
// GitHub delays or drops scheduled workflows on quiet repositories (ours ran
// every three to five hours instead of every 30 minutes). This Worker runs on
// a Cloudflare cron trigger and asks GitHub to run the "Refresh current
// conditions" workflow through its workflow_dispatch hook, to the minute.
//
// Needs one secret: GITHUB_TOKEN, a fine-grained personal access token that
// can only do one thing (Actions: read and write) on one repository
// (cabinradio/cabin-weather). See README.md in this folder.

const OWNER = "cabinradio";
const REPO = "cabin-weather";
const WORKFLOW = "refresh-current.yml";
const REF = "main";

export default {
  async scheduled(event, env, ctx) {
    if (!env.GITHUB_TOKEN) {
      throw new Error("GITHUB_TOKEN secret is not set on this Worker");
    }
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "cabin-weather-trigger (Cloudflare Worker; https://cabinradio.ca)",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: REF }),
    });
    if (response.status !== 204) {
      const text = await response.text();
      // Throwing marks the cron invocation as failed in the Cloudflare dashboard, which is where to look.
      throw new Error(`GitHub refused the dispatch: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    console.log(`dispatched ${WORKFLOW} at ${new Date(event.scheduledTime).toISOString()}`);
  },

  // Someone visiting the Worker's URL gets a one-line answer and nothing happens.
  async fetch() {
    return new Response("Cabin Weather refresh trigger. Nothing to see here.\n", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
