// Cloudflare Pages Function — GET /api/health
//
// "Can the contribution form store anything right now?" Open this URL at every quarterly
// review and before any talk that advertises the form (spec §7, item 6): at ~20 submissions
// a year, silence is normal, so an expired token would otherwise go unnoticed for months.
// Reports only yes/no facts; never reveals the token or the repo name.

export async function onRequestGet({ request, env }) {
  const out = {
    ok: false,
    bot_check_secret_set: !!env.TURNSTILE_SECRET,
    storage_token_set: !!env.GITHUB_TOKEN,
    storage_repo_set: !!env.GITHUB_REPO,
    token_valid_and_repo_found: false,
    repo_is_private: false,
    storing_to: env.STORE_FOLDER === "incoming" ? "incoming (LIVE)" : "test",
    instrument_loaded: false,
    instrument_version: null
  };
  if (out.storage_token_set && out.storage_repo_set) {
    try {
      const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}`, {
        headers: {
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "alliance-cred-contribute"
        }
      });
      if (r.ok) {
        const d = await r.json();
        out.token_valid_and_repo_found = true;
        out.repo_is_private = d.private === true;
      }
    } catch (e) { /* stays false */ }
  }
  try {
    const url = new URL("/instrument.json", request.url);
    const r = env.ASSETS ? await env.ASSETS.fetch(url) : await fetch(url);
    if (r.ok) {
      const d = await r.json();
      out.instrument_loaded = true;
      out.instrument_version = d.instrument_version;
    }
  } catch (e) { /* stays false */ }

  out.ok = out.bot_check_secret_set && out.storage_token_set && out.token_valid_and_repo_found &&
           out.repo_is_private && out.instrument_loaded;
  return new Response(JSON.stringify(out, null, 2), {
    status: out.ok ? 200 : 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
