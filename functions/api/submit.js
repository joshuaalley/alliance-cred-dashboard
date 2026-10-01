// Cloudflare Pages Function — POST /api/submit
//
// Receives one expert contribution from contribute.html, checks it, and stores it as a JSON
// file in a PRIVATE GitHub repo. It contains NO research logic: no source/recipient keys, no
// survey wording, no accept/reject. All of that lives in R (release/contributions/).
// Spec: release/CONTRIBUTION-SPEC.md. Setup: release/contributions/SETUP-PHASE3.md.
//
// Settings (Cloudflare → this Pages project → Settings → Variables and Secrets):
//   TURNSTILE_SECRET  secret  bot-check secret key (Cloudflare → Turnstile)
//   GITHUB_TOKEN      secret  fine-grained token for ONE private repo: Contents + Issues read/write
//   GITHUB_REPO       text    that repo, e.g. joshuaalley/alliance-cred-submissions
//   STORE_FOLDER      text    "test" while testing (files go to test/); "incoming" once live
//   NOTIFY            text    "issue" = open a GitHub issue per submission (GitHub emails you)
//
// Built-in safety:
//   * fails closed — no bot-check secret, or a storage repo that isn't private → nothing stored
//   * a hidden honeypot field silently discards bot submissions
//   * replies never echo personal data back

const MAX_BYTES = 64 * 1024;
const LIMITS = { name: 200, institution: 300, email: 320, comment: 5000, answers: 2000 };

export async function onRequestPost({ request, env }) {
  try {
    const raw = await request.text();
    if (raw.length > MAX_BYTES) return fail(413, "The submission is too large.");
    let p;
    try { p = JSON.parse(raw); } catch { return fail(400, "The submission could not be read."); }
    if (!p || typeof p !== "object") return fail(400, "The submission could not be read.");

    // honeypot: a field people never see but bots fill. Pretend success, store nothing.
    if (p.website) return json({ ok: true, reference: "received" });

    if (!(await turnstileOk(p.turnstile_token, request, env))) {
      return fail(403, "The bot check failed. Please reload the page and try again.");
    }

    const instrument = await loadInstrument(request, env);
    if (!instrument) return fail(503, "The survey is temporarily unavailable.");
    const problems = validate(p, instrument);
    if (problems.length) return fail(422, problems[0], problems);

    // never write personal data anywhere but a private repo
    const repo = await repoInfo(env);
    if (!repo || repo.private !== true) return fail(500, "Storage is misconfigured.");

    const id = crypto.randomUUID();
    const receivedAt = new Date().toISOString();
    const record = {
      submission_id: id,
      received_at: receivedAt,
      instrument_version: p.instrument_version,
      atopid: p.atopid,
      answers: p.answers.map(a => ({ question: a.question, country: a.country, year: a.year, level: a.level })),
      contributor: {
        name: clip(p.contributor.name, LIMITS.name),
        institution: clip(p.contributor.institution, LIMITS.institution),
        email: clip(p.contributor.email, LIMITS.email),
        credit_opt_in: p.contributor.credit_opt_in === true
      },
      consent: true,
      comment: clip(p.comment, LIMITS.comment)
    };

    const folder = env.STORE_FOLDER === "incoming" ? "incoming" : "test";
    const path = `${folder}/${receivedAt.slice(0, 10)}_atop${p.atopid}_${id.slice(0, 8)}.json`;
    const put = await github(env, `contents/${path}`, "PUT", {
      message: `contribution ${id.slice(0, 8)} (ATOP ${p.atopid})`,
      content: base64Utf8(JSON.stringify(record, null, 2) + "\n")
    });
    if (!put.ok) return fail(502, "Your ratings could not be saved.");

    if (env.NOTIFY === "issue") {
      try {   // best effort: the submission is already stored
        await github(env, "issues", "POST", {
          title: `New contribution: ATOP ${p.atopid} (${id.slice(0, 8)})${folder === "test" ? " [test]" : ""}`,
          body: `File: \`${path}\`\nReceived: ${receivedAt}\n\n` +
                "Review with release/contributions/review-submissions.R"
        });
      } catch (e) { /* ignore */ }
    }
    return json({ ok: true, reference: id.slice(0, 8) });
  } catch (e) {
    return fail(500, "Your ratings could not be saved.");
  }
}

// Mirrors validate_submission() in release/contributions/contrib-utils.R (review re-runs that).
function validate(p, instrument) {
  const out = [];
  if (p.instrument_version !== instrument.instrument_version) {
    out.push("The form is out of date. Please reload the page (your answers are kept).");
  }
  const al = instrument.alliances.find(a => a.atopid === p.atopid);
  if (!al) return out.concat("Unknown alliance.");
  const years = new Set(al.years), start = Math.min(...al.years);
  const questions = new Map(al.questions.map(q => [q.id, q]));
  const answers = Array.isArray(p.answers) ? p.answers : [];
  if (answers.length === 0) out.push("No ratings were given.");
  if (answers.length > LIMITS.answers) out.push("Too many ratings.");
  const seen = new Set();
  for (const a of answers) {
    const q = questions.get(a && a.question);
    if (!q) { out.push("Unknown question."); continue; }
    if (a.country !== q.country) out.push(`${q.heading}: wrong member.`);
    if (!years.has(a.year)) out.push(`${q.heading}: year ${a.year} is outside the alliance.`);
    if (![1, 2, 3, 4].includes(a.level)) out.push(`${q.heading}, ${a.year}: invalid level.`);
    const k = `${a.question}|${a.year}`;
    if (seen.has(k)) out.push(`${q.heading}, ${a.year}: rated twice.`);
    seen.add(k);
  }
  for (const q of al.questions) {
    if (!answers.some(a => a && a.question === q.id && a.year === start)) {
      out.push(`${q.heading}: please rate the start year (${start}).`);
    }
  }
  const c = (p.contributor && typeof p.contributor === "object") ? p.contributor : {};
  if (!clip(c.name, LIMITS.name)) out.push("Name is missing.");
  if (!clip(c.institution, LIMITS.institution)) out.push("Institution is missing.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clip(c.email, LIMITS.email))) out.push("Email address is invalid.");
  if (p.consent !== true) out.push("Consent is missing.");
  return out;
}

async function turnstileOk(token, request, env) {
  if (!env.TURNSTILE_SECRET || !token) return false;             // fail closed
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", String(token));
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const d = await r.json().catch(() => ({}));
  return d.success === true;
}

// instrument.json is published next to contribute.html, i.e. at the site root
async function loadInstrument(request, env) {
  try {
    const url = new URL("/instrument.json", request.url);
    const r = env.ASSETS ? await env.ASSETS.fetch(url) : await fetch(url);
    return r.ok ? await r.json() : null;
  } catch (e) {
    return null;
  }
}

async function repoInfo(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return null;
  const r = await github(env, "", "GET");
  return r.ok ? r.json() : null;
}

function github(env, path, method, body) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}${path ? "/" + path : ""}`;
  return fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "alliance-cred-contribute",
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

// UTF-8 safe (names like "Müller", "protégés"); chunked so large payloads can't overflow
function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function clip(s, n) { return String(s ?? "").trim().slice(0, n); }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
function fail(status, error, problems) {
  return json(problems ? { ok: false, error, problems } : { ok: false, error }, status);
}
