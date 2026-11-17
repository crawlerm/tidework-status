// tidework status collector.
//
// Runs on GitHub Actions every 30 min (see .github/workflows/collect.yml), OUTSIDE Supabase
// and Vercel, so it keeps reporting when either of them is down. It probes every service,
// gauge and upstream feed, then writes one status.json that index.html renders.
//
// This repo is PUBLIC. Nothing written to status.json may contain a secret, a request URL
// (HHA URLs carry site PINs) or a raw upstream error body — only cleaned codes and reasons.
//
// Usage: node collect.mjs <out-path>      (env vars: see README.md)

import { writeFile } from "node:fs/promises";
import { resolve4 } from "node:dns/promises";
import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamily } from "node:net";

// GitHub's runners advertise IPv6 they can't always route; Open-Meteo then times out on connect.
setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamily(true);

const OUT = process.argv[2] || "site/status.json";
// SIMULATE=supabase points the collector at a dead host, to prove the "Supabase down" path.
const SB_URL = process.env.SIMULATE === "supabase" ? "https://supabase-down.invalid/rest/v1" : "https://otxwipspvafbgbemfbqy.supabase.co/rest/v1";
// Publishable (anon) key: already public in every wbtide page; read-only under RLS.
const SB_KEY = "sb_publishable_QzT5boJEpvDRntDKCiPojQ_oE7eG53B";
const PAGES_URL = process.env.PAGES_URL || "";             // previous status.json, for history
const HISTORY_LEN = 48;                                    // 48 runs x 30 min = 24 h
const env = (k) => (process.env[k] || "").trim();

const started = Date.now();
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const NOW_NAIVE = new Date().toISOString().slice(0, 19);   // mastertides datetimes are naive UTC

// ---------------------------------------------------------------- helpers

/** fetch that never throws; returns {ok, status, ms, text, json(), headers, err}.
 *  Retries once on a network error or timeout: GitHub's runners see occasional transient
 *  connect timeouts that are not the upstream's fault. */
async function probe(url, opts = {}) {
  const r = await probeOnce(url, opts);
  return r.status === 0 ? probeOnce(url, opts) : r;
}
async function probeOnce(url, { timeout = 12000, headers = {}, method = "GET", body } = {}) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { method, headers: { "User-Agent": "tidework-status/1", ...headers }, body, signal: ctl.signal, redirect: "follow" });
    const text = await r.text();
    return { ok: r.ok, status: r.status, ms: Date.now() - t0, text, headers: r.headers,
             json() { try { return JSON.parse(text); } catch { return null; } }, err: null };
  } catch (e) {
    const err = e.name === "AbortError" ? `timeout after ${timeout / 1000}s` : cleanErr(e);
    return { ok: false, status: 0, ms: Date.now() - t0, text: "", headers: new Headers(), json: () => null, err };
  } finally { clearTimeout(timer); }
}

/** Cleaned, URL-free error text. */
function cleanErr(e) {
  const m = String(e?.cause?.code || e?.code || e?.message || e).replace(/https?:\/\/\S+/g, "[url]");
  return m.slice(0, 120);
}
const httpReason = (r) => r.err || `HTTP ${r.status}`;

const minsSince = (iso) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 60000) : null);
const toIso = (naiveUtc) => (naiveUtc ? (/[zZ]|[+-]\d\d:\d\d$/.test(naiveUtc) ? naiveUtc : naiveUtc + "Z") : null);
const isoClean = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Europe/London wall-clock "YYYY-MM-DD HH:MM:SS" → UTC ISO */
function londonToIso(s) {
  const guess = Date.parse(s.replace(" ", "T") + "Z");
  if (Number.isNaN(guess)) return null;
  const tz = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" })
    .formatToParts(new Date(guess)).find((p) => p.type === "timeZoneName")?.value || "GMT";
  const off = tz === "GMT" ? 0 : parseInt(tz.replace("GMT", ""), 10) * 60;
  return isoClean(guess - off * 60000);
}

const RANK = { green: 0, grey: 1, amber: 2, red: 3 };
const worst = (...ls) => ls.filter(Boolean).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "green");
const ageLight = (age, amber, red) => (age == null ? "red" : age > red ? "red" : age > amber ? "amber" : "green");
const fmtAge = (m) => (m == null ? "never" : m < 120 ? `${m} min` : m < 2880 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} d`);

function check(id, label, light, detail = null, ms = null) {
  return { id, label, ok: light === "green", light, ms, detail };
}

// ---------------------------------------------------------------- shared probes

const sb = (path) => probe(`${SB_URL}/${path}`, { headers: { apikey: SB_KEY } });

/** Newest real observation for a location (filtered to an observation-only column, because
 *  several locations carry future-dated prediction rows that would look fresh forever). */
async function latestObs(location, column) {
  // column=null: location has no future rows, so the plain newest row is the fast, correct query
  // (the column filter + now-bound forces a sort of every TideMill row and can hit the anon timeout).
  const q = column ? `&${column}=not.is.null&datetime=lte.${NOW_NAIVE}` : "";
  let r = await sb(`mastertides?select=datetime&location=eq.${location}${q}&order=datetime.desc&limit=1`);
  if (r.status >= 500) r = await sb(`mastertides?select=datetime&location=eq.${location}${q}&order=datetime.desc&limit=1`);
  if (!r.ok) return { ts: null, err: httpReason(r), ms: r.ms };
  const ts = toIso(r.json()?.[0]?.datetime);
  return { ts, err: ts ? null : "no observations", ms: r.ms };
}

async function obsCheck(id, label, location, column, amber, red) {
  const o = await latestObs(location, column);
  const age = minsSince(o.ts);
  const light = o.err && !o.ts ? "red" : ageLight(age, amber, red);
  return { ...check(id, label, light, o.ts ? `${fmtAge(age)} old (amber > ${amber} min)` : o.err, o.ms), ts: o.ts, queryFailed: !!o.err && !o.ts && o.err !== "no observations" };
}

/** Atlassian Statuspage → {light, text, incidents}. `components` limits it to named parts. */
async function statuspage(base, components) {
  const r = await probe(`${base}/api/v2/summary.json`);
  const j = r.json();
  if (!j) return { light: "grey", text: `status page unreachable (${httpReason(r)})`, indicator: null, incidents: [], source: new URL(base).host };
  // Region-specific incidents (e.g. "ap-northeast-2") only matter for our own region.
  const region = env("SUPABASE_REGION") || "eu-west-2";
  const relevant = (i) => { const m = i.name.match(/\b[a-z]{2}-[a-z]+-\d\b/g); return !m || m.includes(region); };
  const incidents = (j.incidents || []).filter(relevant).slice(0, 3).map((i) => ({ name: i.name, status: i.status, updated: i.updated_at }));
  const src = new URL(base).host;
  if (components) {
    const map = { operational: "green", degraded_performance: "amber", partial_outage: "amber", under_maintenance: "amber", major_outage: "red" };
    const parts = (j.components || []).filter((c) => components.includes(c.name));
    const bad = parts.filter((c) => c.status !== "operational");
    const light = worst(...parts.map((c) => map[c.status] || "amber"));
    const text = bad.length ? bad.map((c) => `${c.name}: ${c.status.replace(/_/g, " ")}`).join("; ") : `${components.join(", ")}: operational`;
    return { light, text, indicator: bad.length ? "minor" : "none", incidents: incidents.filter((i) => components.some((c) => i.name.includes(c))), source: src };
  }
  const ind = j.status?.indicator;
  const light = ind === "none" ? "green" : ind === "minor" || ind === "maintenance" ? "amber" : "red";
  return { light, text: j.status?.description || "unknown", indicator: ind, incidents, source: src };
}

/** Item skeleton. light is computed later from checks + capacity + provider status. */
function item(id, label, group, extra = {}) {
  return { id, label, group, light: "grey", reason: "", last_heard: null, age_min: null,
           provider_status: null, checks: [], capacity: [], thresholds: null, depends_on: [], fed_by: [], error: null, ...extra };
}

function finish(it, { lastHeard = null, providerCounts = true } = {}) {
  // An upstream we can't reach from GitHub while our own stored copy is fresh is a warning,
  // not a failure: the data is still arriving by the path that matters.
  const up = it.checks.find((c) => c.id === "upstream");
  const stored = it.checks.filter((c) => c.id !== "upstream");
  if (up && up.light === "red" && stored.length && stored.every((c) => c.light === "green")) {
    up.light = "amber"; up.detail = `${up.detail} (our stored copy is still fresh)`;
  }
  // grey = "not measured" (unconfigured capacity, unreachable status page): it never outranks
  // a real measurement. An item is grey only if nothing about it could be measured.
  const all = it.checks.map((c) => c.light).concat(it.capacity.map((c) => c.light));
  if (providerCounts && it.provider_status) all.push(it.provider_status.light);
  const real = all.filter((l) => l !== "grey");
  it.light = real.length ? worst(...real) : "grey";
  it.last_heard = lastHeard;
  it.age_min = minsSince(lastHeard);
  const bad = it.checks.filter((c) => c.light !== "green").concat(it.capacity.filter((c) => c.light !== "green" && c.light !== "grey"));
  if (it.light === "green") it.reason = "";
  else if (bad.length) it.reason = bad.map((c) => `${c.label}${c.detail ? ": " + c.detail : c.pct != null ? `: ${c.pct}%` : ""}`).join(" · ");
  else if (it.provider_status) it.reason = it.provider_status.text;
  const firstBad = it.checks.find((c) => c.light === "red");
  if (firstBad) it.error = { code: firstBad.detail || "failed", message: firstBad.label, since: null };
  return it;
}

// ---------------------------------------------------------------- services

async function supabase() {
  const it = item("supabase", "Supabase", "services", { thresholds: { amber_pct: 80, red_pct: 90 } });
  const [sp, rest, size] = await Promise.all([
    statuspage("https://status.supabase.com"),
    sb("constants?select=constantname&limit=1"),
    probe(`${SB_URL}/rpc/db_size_mb`, { method: "POST", headers: { apikey: SB_KEY, "Content-Type": "application/json" }, body: "{}" }),
  ]);
  it.provider_status = sp;
  it.checks.push(check("rest", "REST API answers", rest.ok ? "green" : "red", rest.ok ? null : httpReason(rest), rest.ms));
  const mb = Number(size.json());
  if (size.ok && Number.isFinite(mb)) {
    const pct = +(100 * mb / 500).toFixed(1);
    it.capacity.push({ id: "db_size", label: "Database", used: +mb.toFixed(1), limit: 500, unit: "MB", pct, light: pct >= 90 ? "red" : pct >= 80 ? "amber" : "green" });
  } else {
    it.capacity.push({ id: "db_size", label: "Database", used: null, limit: 500, unit: "MB", pct: null, light: "grey", note: "db_size_mb() not installed" });
  }
  return finish(it, { lastHeard: rest.ok ? nowIso() : null });
}

async function vercel() {
  const it = item("vercel", "Vercel", "services");
  const sites = [["wbtide", "https://wbtide.vercel.app/"], ["eccapp", "https://eccapp.vercel.app/"]];
  const [sp, ...rs] = await Promise.all([statuspage("https://www.vercel-status.com"), ...sites.map(([, u]) => probe(u))]);
  it.provider_status = sp;
  sites.forEach(([n], i) => it.checks.push(check(`site_${n}`, `${n}.vercel.app`, rs[i].ok ? "green" : "red", rs[i].ok ? null : httpReason(rs[i]), rs[i].ms)));

  const token = env("VERCEL_TOKEN");
  if (token) {
    const team = env("VERCEL_TEAM_ID") ? `&teamId=${env("VERCEL_TEAM_ID")}` : "";
    const deps = await Promise.all(sites.map(([n]) =>
      probe(`https://api.vercel.com/v6/deployments?projectId=${n}&target=production&limit=1${team}`, { headers: { Authorization: `Bearer ${token}` } })));
    sites.forEach(([n], i) => {
      const d = deps[i].json()?.deployments?.[0];
      const state = d?.state || d?.readyState;
      const light = !deps[i].ok ? "grey" : state === "READY" ? "green" : state === "ERROR" ? "red" : "amber";
      it.checks.push(check(`deploy_${n}`, `${n} latest production deploy`, light,
        deps[i].ok ? `${state || "none"}${d?.created ? ", " + fmtAge(minsSince(isoClean(d.created))) + " ago" : ""}` : `API ${httpReason(deps[i])}`));
    });
  }
  return finish(it, { lastHeard: rs.some((r) => r.ok) ? nowIso() : null });
}

async function cloudflare() {
  const it = item("cloudflare", "Cloudflare", "services");
  const [sp, dns] = await Promise.all([
    statuspage("https://www.cloudflarestatus.com", ["Authoritative DNS", "Recursive DNS", "Custom Pages"]),
    resolve4("eastcoastcurious.uk").then((a) => ({ ok: a.length > 0, a }), (e) => ({ ok: false, err: cleanErr(e) })),
  ]);
  it.provider_status = sp;
  it.checks.push(check("dns", "eastcoastcurious.uk resolves", dns.ok ? "green" : "red", dns.ok ? null : dns.err));
  return finish(it, { lastHeard: dns.ok ? nowIso() : null });
}

async function r2() {
  const it = item("r2", "Cloudflare R2", "services", { thresholds: { amber_pct: 80, red_pct: 90 } });
  it.provider_status = await statuspage("https://www.cloudflarestatus.com", ["R2"]);
  const token = env("CF_API_TOKEN"), acct = env("CF_ACCOUNT_ID");
  const LIMIT_GB = 10;
  if (!token || !acct) {
    it.capacity.push({ id: "storage", label: "Storage", used: null, limit: LIMIT_GB, unit: "GB", pct: null, light: "grey", note: "CF_API_TOKEN / CF_ACCOUNT_ID not set" });
    return finish(it, { lastHeard: null });
  }
  const since = new Date(Date.now() - 2 * 86400000).toISOString();
  const query = `query($a:String!,$s:Time!){viewer{accounts(filter:{accountTag:$a}){r2StorageAdaptiveGroups(limit:1000,filter:{datetime_geq:$s},orderBy:[datetime_DESC]){max{payloadSize metadataSize objectCount}dimensions{datetime bucketName}}}}}`;
  const r = await probe("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { a: acct, s: since } }) });
  const rows = r.json()?.data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups;
  if (!r.ok || !Array.isArray(rows)) {
    const gqlErr = r.json()?.errors?.[0]?.message;
    it.checks.push(check("analytics", "Usage API answers", "amber", gqlErr ? cleanErr(gqlErr) : httpReason(r), r.ms));
    return finish(it, { lastHeard: null });
  }
  const latest = new Map();                       // newest sample per bucket
  for (const g of rows) if (!latest.has(g.dimensions.bucketName)) latest.set(g.dimensions.bucketName, g);
  let bytes = 0, objects = 0;
  for (const g of latest.values()) { bytes += (g.max.payloadSize || 0) + (g.max.metadataSize || 0); objects += g.max.objectCount || 0; }
  const gb = bytes / 1e9, pct = +(100 * gb / LIMIT_GB).toFixed(1);
  it.capacity.push({ id: "storage", label: `Storage (${latest.size} bucket${latest.size === 1 ? "" : "s"}, ${objects.toLocaleString("en-GB")} objects)`,
    used: +gb.toFixed(2), limit: LIMIT_GB, unit: "GB", pct, light: pct >= 90 ? "red" : pct >= 80 ? "amber" : "green" });
  it.checks.push(check("analytics", "Usage API answers", "green", null, r.ms));
  return finish(it, { lastHeard: nowIso() });
}

async function wordpress() {
  const it = item("wordpress", "eastcoastcurious.uk", "services");
  const r = await probe("https://eastcoastcurious.uk/");
  it.checks.push(check("home", "Home page loads", r.ok ? "green" : "red", r.ok ? null : httpReason(r), r.ms));
  it.depends_on = ["cloudflare"];
  return finish(it, { lastHeard: r.ok ? nowIso() : null });
}

async function pcGpu() {
  const it = item("pc_gpu", "PC GPU", "services", { thresholds: { amber_min: 30, red_min: 60 } });
  const gist = env("GPU_GIST_ID");
  if (!gist) {
    it.checks.push(check("heartbeat", "Heartbeat", "grey", "GPU_GIST_ID not set"));
    it.light = "grey"; it.reason = "Not configured — see pc/README";
    return it;
  }
  const h = env("GITHUB_TOKEN") ? { Authorization: `Bearer ${env("GITHUB_TOKEN")}` } : {};
  const r = await probe(`https://api.github.com/gists/${gist}`, { headers: { ...h, Accept: "application/vnd.github+json" } });
  let hb = null;
  try { hb = JSON.parse(r.json()?.files?.["heartbeat.json"]?.content || "null"); } catch {}
  if (!hb?.ts) {
    it.checks.push(check("heartbeat", "Heartbeat", "red", r.ok ? "no heartbeat.json in gist" : httpReason(r), r.ms));
    return finish(it, { lastHeard: null });
  }
  const ts = isoClean(hb.ts), age = minsSince(ts);
  it.checks.push(check("heartbeat", "Heartbeat", ageLight(age, 30, 60), `${fmtAge(age)} old`));
  it.checks.push(check("cuda", "CUDA available", age > 60 ? "grey" : hb.cuda ? "green" : "red", hb.gpu_name || (hb.cuda ? null : hb.error || "nvidia-smi failed")));
  if (hb.cuda && age <= 60) {
    if (hb.util_pct != null) it.capacity.push({ id: "util", label: "GPU busy", used: hb.util_pct, limit: 100, unit: "%", pct: hb.util_pct, light: "green" });
    if (hb.mem_used_mb != null && hb.mem_total_mb) {
      const pct = +(100 * hb.mem_used_mb / hb.mem_total_mb).toFixed(1);
      it.capacity.push({ id: "vram", label: "VRAM", used: +(hb.mem_used_mb / 1024).toFixed(1), limit: +(hb.mem_total_mb / 1024).toFixed(1), unit: "GB", pct, light: "green" });
    }
    if (hb.temp_c != null) it.checks.push(check("temp", "GPU temperature", hb.temp_c >= 85 ? "amber" : "green", `${hb.temp_c} °C`));
  }
  return finish(it, { lastHeard: ts });
}

// ---------------------------------------------------------------- our gauges

async function gauge(id, label, location, column, amber, red, fedBy) {
  const it = item(id, label, "gauges", { thresholds: { amber_min: amber, red_min: red }, depends_on: ["supabase"], fed_by: fedBy });
  const c = await obsCheck("obs", "Latest reading", location, column, amber, red);
  it.checks.push(c);
  it._queryFailed = c.queryFailed;
  return finish(it, { lastHeard: c.ts });
}

// ---------------------------------------------------------------- external feeds
// Two kinds of check per feed: does the upstream answer, and is our stored copy fresh?
// That split is what tells "their side is down" from "our sync is broken".

async function hha() {
  const it = item("hha", "HHA Port-Log", "upstreams", { depends_on: ["supabase"] });
  const sites = [
    ["wl", "Wadgate Ledge", "WL", "wlheight", 60, 120],
    ["ftm", "Fort Massac", "FTMassac", "ftmheight", 60, 120],
    ["hh", "Harwich", "Harwich", "hhheight", 60, 120],
    ["ips", "Ipswich", "Ipswich", "ipsheight", 60, 120],
    ["lg", "Landguard met", "Landguard", "lgwindsp", 60, 120],
    ["wr", "Felixstowe Waverider", "WaveRider", "wave_hm0", 120, 240],
  ];
  const [up, ...cs] = await Promise.all([
    probe("https://hha.port-log.net/", { timeout: 20000 }),
    ...sites.map(([id, l, loc, col, a, r]) => obsCheck(id, `Stored: ${l}`, loc, col, a, r)),
  ]);
  it.checks.push(check("upstream", "Upstream answers", up.ok ? "green" : "red", up.ok ? null : httpReason(up), up.ms), ...cs);
  it._queryFailed = cs.every((c) => c.queryFailed);
  const newest = cs.map((c) => c.ts).filter(Boolean).sort().pop() || null;
  return finish(it, { lastHeard: newest });
}

async function codingforcodgers() {
  const it = item("codingforcodgers", "codingforcodgers (WBY)", "upstreams", { thresholds: { amber_min: 30, red_min: 60 } });
  const ym = (d) => d.toISOString().slice(0, 7);
  let r = await probe(`https://codingforcodgers.co.uk/codgers/tide/${ym(new Date())}-tide.txt`);
  if (r.status === 404) r = await probe(`https://codingforcodgers.co.uk/codgers/tide/${ym(new Date(Date.now() - 86400000))}-tide.txt`);
  if (!r.ok) { it.checks.push(check("file", "Monthly file answers", "red", httpReason(r), r.ms)); return finish(it); }
  const last = r.text.trim().split(/\r?\n/).pop() || "";
  const ts = londonToIso(last.split(",")[0]);
  const age = minsSince(ts);
  it.checks.push(check("file", "Monthly file answers", "green", null, r.ms));
  it.checks.push(check("fresh", "Newest reading in file", ageLight(age, 30, 60), ts ? `${fmtAge(age)} old` : "unparseable"));
  return finish(it, { lastHeard: ts });
}

async function govukFlood() {
  const it = item("govuk_flood", "GOV.UK flood (Woodbridge)", "upstreams");
  const r = await probe("https://check-for-flooding.service.gov.uk/station-csv/6297");
  if (!r.ok) { it.checks.push(check("csv", "Station CSV answers", "red", httpReason(r), r.ms)); return finish(it); }
  const ts = r.text.trim().split(/\r?\n/).pop()?.split(",")[0];
  const iso = ts && !Number.isNaN(Date.parse(ts)) ? isoClean(ts) : null;
  const age = minsSince(iso);
  it.checks.push(check("csv", "Station CSV answers", "green", null, r.ms));
  it.checks.push(check("fresh", "Newest reading in CSV", ageLight(age, 60, 180), iso ? `${fmtAge(age)} old` : "unparseable"));
  return finish(it, { lastHeard: iso });
}

async function wavenet() {
  const it = item("wavenet", "CEFAS WaveNet", "upstreams", { depends_on: ["supabase"] });
  const [up, fc] = await Promise.all([
    probe("https://wavenet-api.cefas.co.uk/api/Detail/Results/367/EXT?showForecast=true", { timeout: 15000 }),
    sb("mastertides?select=datetime&location=eq.FelxFcst&wave_hm0=not.is.null&order=datetime.desc&limit=1"),
  ]);
  it.checks.push(check("upstream", "Upstream answers", up.ok ? "green" : "red", up.ok ? null : httpReason(up), up.ms));
  // Forward coverage: wave forecast rows are future-dated, so measure how far ahead they reach.
  const end = toIso(fc.json()?.[0]?.datetime);
  const aheadH = end ? Math.round((Date.parse(end) - Date.now()) / 3600000) : null;
  it.checks.push(check("stored", "Stored: wave forecast reaches ahead", !fc.ok ? "red" : aheadH == null ? "red" : aheadH >= 48 ? "green" : aheadH >= 12 ? "amber" : "red",
    !fc.ok ? httpReason(fc) : aheadH == null ? "no rows" : `${aheadH} h ahead`, fc.ms));
  it._queryFailed = !fc.ok;
  return finish(it, { lastHeard: up.ok ? nowIso() : null });
}

async function openmeteo() {
  const it = item("openmeteo", "Open-Meteo", "upstreams", { depends_on: ["supabase"] });
  const [up, fc] = await Promise.all([
    probe("https://api.open-meteo.com/v1/forecast?latitude=52.05&longitude=1.33&current=temperature_2m"),
    sb("mastertides?select=created_at&location=eq.FelxFcst&order=created_at.desc&limit=1"),
  ]);
  it.checks.push(check("upstream", "Upstream answers", up.ok ? "green" : "red", up.ok ? null : httpReason(up), up.ms));
  const ts = fc.json()?.[0]?.created_at ? isoClean(fc.json()[0].created_at) : null;
  const ageH = ts ? minsSince(ts) / 60 : null;
  it.checks.push(check("stored", "Stored: forecast last written", !fc.ok || ageH == null ? "red" : ageH > 48 ? "red" : ageH > 30 ? "amber" : "green",
    !fc.ok ? httpReason(fc) : ts ? `${fmtAge(minsSince(ts))} ago` : "no rows", fc.ms));
  it._queryFailed = !fc.ok;
  return finish(it, { lastHeard: ts });
}

async function thingsboard() {
  const it = item("thingsboard", "Tide Mill (ThingsBoard)", "upstreams", { depends_on: ["supabase"] });
  const [up, c] = await Promise.all([
    probe("https://dashboard.thingitude-apps.com/"),
    obsCheck("stored", "Stored: river temperature", "TideMill", null, 180, 360),
  ]);
  it.checks.push(check("upstream", "Upstream answers", up.ok ? "green" : "red", up.ok ? null : httpReason(up), up.ms), c);
  it._queryFailed = c.queryFailed;
  return finish(it, { lastHeard: c.ts });
}

async function wsc() {
  const it = item("wsc", "Waldringfield SC wind", "upstreams", { thresholds: { amber_min: 30, red_min: 60 } });
  const r = await probe("https://waldringfieldsc.com/weather/Current_Vantage_Pro.htm");
  if (!r.ok) { it.checks.push(check("page", "Weather page answers", "red", httpReason(r), r.ms)); return finish(it); }
  const lm = r.headers.get("last-modified");
  const ts = lm ? isoClean(lm) : null, age = minsSince(ts);
  it.checks.push(check("page", "Weather page answers", "green", null, r.ms));
  it.checks.push(check("fresh", "Page last updated", ageLight(age, 30, 60), ts ? `${fmtAge(age)} ago` : "no Last-Modified header"));
  return finish(it, { lastHeard: ts });
}

async function pla() {
  // PLA blocks cloud IPs (Cloudflare challenge), so there is no upstream probe from here.
  // What matters is how far ahead the loaded Walton predictions reach.
  const it = item("pla", "PLA Walton predictions", "upstreams", { depends_on: ["supabase"] });
  const r = await sb("wontide?select=won_hw_datetime&order=won_hw_datetime.desc&limit=1");
  const end = toIso(r.json()?.[0]?.won_hw_datetime);
  const months = end ? +((Date.parse(end) - Date.now()) / (30.44 * 86400000)).toFixed(1) : null;
  it.checks.push(check("cover", "Predictions loaded ahead", !r.ok || months == null ? "red" : months >= 6 ? "green" : months >= 3 ? "amber" : "red",
    !r.ok ? httpReason(r) : end ? `to ${end.slice(0, 10)} (${months} months)` : "no rows", r.ms));
  it._queryFailed = !r.ok;
  return finish(it, { lastHeard: null });
}

// ---------------------------------------------------------------- assemble

async function previousHistory() {
  if (!PAGES_URL) return {};
  const r = await probe(`${PAGES_URL.replace(/\/$/, "")}/status.json?ts=${Date.now()}`);
  return r.json()?.history || {};
}

const settle = (p, id, label, group) => p.catch((e) => {
  const it = item(id, label, group);
  it.light = "red"; it.reason = `collector error: ${cleanErr(e)}`;
  it.checks.push(check("collector", "Collector", "red", cleanErr(e)));
  return it;
});

const tasks = [
  [supabase(), "supabase", "Supabase", "services"],
  [vercel(), "vercel", "Vercel", "services"],
  [cloudflare(), "cloudflare", "Cloudflare", "services"],
  [r2(), "r2", "Cloudflare R2", "services"],
  [wordpress(), "wordpress", "eastcoastcurious.uk", "services"],
  [pcGpu(), "pc_gpu", "PC GPU", "services"],
  [gauge("gauge_lev", "Levington (LEV)", "SYH", "syhheightraw", 60, 180, []), "gauge_lev", "Levington (LEV)", "gauges"],
  [gauge("gauge_wby", "Waldringfield (WBY)", "WBY", "wbyheightraw", 45, 90, ["codingforcodgers"]), "gauge_wby", "Waldringfield (WBY)", "gauges"],
  [gauge("gauge_wb", "Woodbridge (WB)", "woodbridge", "wbheightraw", 60, 180, ["govuk_flood"]), "gauge_wb", "Woodbridge (WB)", "gauges"],
  [hha(), "hha", "HHA Port-Log", "upstreams"],
  [codingforcodgers(), "codingforcodgers", "codingforcodgers", "upstreams"],
  [govukFlood(), "govuk_flood", "GOV.UK flood", "upstreams"],
  [wavenet(), "wavenet", "CEFAS WaveNet", "upstreams"],
  [openmeteo(), "openmeteo", "Open-Meteo", "upstreams"],
  [thingsboard(), "thingsboard", "Tide Mill", "upstreams"],
  [wsc(), "wsc", "Waldringfield SC wind", "upstreams"],
  [pla(), "pla", "PLA predictions", "upstreams"],
];

const [prevHistory, ...items] = await Promise.all([previousHistory(), ...tasks.map(([p, ...a]) => settle(p, ...a))]);
const byId = Object.fromEntries(items.map((i) => [i.id, i]));

// Dependencies. If Supabase (the thing we measure through) is down, items that could not be
// queried are UNKNOWN, not failed: grey them so one outage doesn't paint the board red.
// If a feeding upstream is red, keep the item's own light but name the likely cause.
for (const it of items) {
  for (const d of it.depends_on) {
    if (byId[d]?.light === "red" && it._queryFailed) {
      const up = it.checks.find((c) => c.id === "upstream");
      it.light = "grey";
      it.reason = `stored data unknown — ${byId[d].label} down${up ? (up.ok ? " · upstream answering" : " · upstream also failing") : ""}`;
    }
  }
  for (const f of it.fed_by) {
    if (it.light !== "green" && byId[f] && byId[f].light !== "green") it.reason += ` · likely cause: ${byId[f].label} ${byId[f].light === "red" ? "down" : "degraded"}`;
  }
  delete it._queryFailed;
}

const L = { green: "G", amber: "A", red: "R", grey: "X" };
const history = {};
for (const it of items) history[it.id] = ((prevHistory[it.id] || "") + L[it.light]).slice(-HISTORY_LEN);

const counts = { green: 0, amber: 0, red: 0, grey: 0 };
items.forEach((i) => counts[i.light]++);

const status = {
  schema: 1,
  generated_at: nowIso(),
  collector: {
    run_url: env("GITHUB_RUN_ID") ? `${env("GITHUB_SERVER_URL")}/${env("GITHUB_REPOSITORY")}/actions/runs/${env("GITHUB_RUN_ID")}` : null,
    duration_ms: Date.now() - started,
    interval_min: 30,
  },
  summary: { worst: worst(...items.map((i) => i.light)), ...counts },
  groups: [
    { id: "services", label: "Services" },
    { id: "gauges", label: "Our gauges" },
    { id: "upstreams", label: "External feeds" },
  ],
  items,
  history,
};

await writeFile(OUT, JSON.stringify(status, null, 2));
console.log(`wrote ${OUT}: ${items.length} items, worst=${status.summary.worst}, ${status.collector.duration_ms} ms`);
for (const i of items) console.log(`  ${i.light.padEnd(5)} ${i.id.padEnd(17)} ${i.reason}`);
