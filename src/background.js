// Background service worker: owns all network access (YouTube Data API +
// watch-page fallback fetches) and the local cache.
// content.js never talks to the network directly — it only messages this worker.

importScripts("label-strings.js"); // AI_LABEL_PHRASES, AI_DISCLOSURE_SUPPORT_ARTICLE_ID

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Bump this whenever checkWatchPageForAILabel's verdict logic changes in a
// way that could flip a past result (new signal, new exclusion, bug fix).
// Cache entries written under an older version are treated as stale
// regardless of their TTL, so a logic fix takes effect immediately instead
// of waiting up to 7 days for old (possibly wrong) cached verdicts to
// expire naturally. Bumped for the disclosure-type-specific matching fix
// (auto-dub vs. synthetic-content) and the secondaryResults scoping fix.
const CACHE_SCHEMA_VERSION = 2;
const CHUNK_SIZE = 50; // videos.list accepts up to 50 IDs per call, ~1 quota unit regardless of count
const API_KEY_STORAGE_KEY = "ytaif_apiKey";
const FILTER_ENABLED_KEY = "ytaif_filterEnabled";
const SCAN_INTENSITY_KEY = "ytaif_scanIntensity"; // "off" | "normal" | "thorough"
const HIDE_MODE_KEY = "ytaif_hideMode"; // "remove" | "overlay" — read only by content.js, not used here
// entries: { synthetic: boolean, method: "api" | "watch-page" | null, checkedAt, schemaVersion }
const CACHE_KEY_PREFIX = "ytaif_cache_";
const QUOTA_EXHAUSTED_KEY = "ytaif_quotaExhaustedUntil";
const SESSION_API_COUNT_KEY = "ytaif_sessionApiHiddenCount";
const SESSION_SCAN_COUNT_KEY = "ytaif_sessionScanHiddenCount";
const PASS1_ENABLED_KEY = "ytaif_pass1Enabled"; // Data API disclosure check on/off

// --- Community channel-blocklist signal (AiSList) ---------------------------
// A third, independent signal, deliberately weaker than Pass 1/2: those two
// only ever relay YouTube's OWN stated verdict (creator disclosure, or
// YouTube's own auto-detect label), so they're high-precision by
// construction. This is a third-party, crowd-sourced list of channels that
// primarily post AI-generated content — useful for recall, but it can go
// stale (a channel that reforms or renames stays listed indefinitely per the
// source's own docs). It must NEVER hide/remove a video — see content.js,
// where it only ever attaches a non-blocking badge, never touches
// hideCard/applyRemovedStyle/overlay code. CC BY-NC 4.0 — attribution is
// surfaced in the popup.
const AISLIST_BLOCKLIST_URL =
  "https://raw.githubusercontent.com/Override92/AiSList/main/AiSList/aislist_blocklist.txt";
const AISLIST_WARNLIST_URL =
  "https://raw.githubusercontent.com/Override92/AiSList/main/AiSList/aislist_warnlist.txt";
const CHANNEL_LIST_KEY = "ytaif_channelLists"; // { blocklist: string[], warnlist: string[], fetchedAt }
const CHANNEL_BADGE_ENABLED_KEY = "ytaif_channelBadgeEnabled";
const CHANNEL_LIST_ALARM_NAME = "ytaif-refresh-channel-lists";
const CHANNEL_LIST_REFRESH_MINUTES = 12 * 60; // matches the list's own daily-ish update cadence

// Spacing between successive watch-page fetches, keyed by scan intensity.
// "off" disables the fallback entirely (only the Data API check runs).
// "thorough" is the more cautious/slower option for users who want extra
// breathing room between requests — not "faster", just more patient.
const SCAN_INTENSITY_SPACING_MS = {
  normal: 500,
  thorough: 1200,
};
const MAX_CONCURRENT_WATCH_FETCHES = 1; // serial queue — see README rationale

function getNextPacificMidnightUTC() {
  // YouTube Data API quota resets at midnight Pacific Time.
  // Approximate using a fixed UTC-8 offset (close enough for a "try again" hint).
  const now = new Date();
  const pacificOffsetHours = 8;
  const nowUtcMs = now.getTime();
  const nowPacific = new Date(nowUtcMs - pacificOffsetHours * 60 * 60 * 1000);
  const nextMidnightPacific = new Date(
    Date.UTC(
      nowPacific.getUTCFullYear(),
      nowPacific.getUTCMonth(),
      nowPacific.getUTCDate() + 1,
      0, 0, 0, 0
    )
  );
  return nextMidnightPacific.getTime() + pacificOffsetHours * 60 * 60 * 1000;
}

async function getApiKey() {
  const result = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
  return result[API_KEY_STORAGE_KEY] || null;
}

async function getScanIntensity() {
  const result = await chrome.storage.local.get(SCAN_INTENSITY_KEY);
  return result[SCAN_INTENSITY_KEY] || "normal";
}

async function getPass1Enabled() {
  const result = await chrome.storage.local.get(PASS1_ENABLED_KEY);
  return result[PASS1_ENABLED_KEY] !== false; // default true
}

async function getChannelBadgeEnabled() {
  const result = await chrome.storage.local.get(CHANNEL_BADGE_ENABLED_KEY);
  return result[CHANNEL_BADGE_ENABLED_KEY] !== false; // default true
}

async function getQuotaExhaustedUntil() {
  const result = await chrome.storage.local.get(QUOTA_EXHAUSTED_KEY);
  const until = result[QUOTA_EXHAUSTED_KEY];
  if (!until) return null;
  if (Date.now() >= until) {
    await chrome.storage.local.remove(QUOTA_EXHAUSTED_KEY);
    return null;
  }
  return until;
}

async function setQuotaExhausted() {
  const until = getNextPacificMidnightUTC();
  await chrome.storage.local.set({ [QUOTA_EXHAUSTED_KEY]: until });
  return until;
}

async function getCachedEntries(videoIds) {
  const keys = videoIds.map((id) => CACHE_KEY_PREFIX + id);
  const result = await chrome.storage.local.get(keys);
  const fresh = {};
  const stale = [];
  const now = Date.now();
  for (const id of videoIds) {
    const entry = result[CACHE_KEY_PREFIX + id];
    const isCurrentSchema = entry && entry.schemaVersion === CACHE_SCHEMA_VERSION;
    if (isCurrentSchema && now - entry.checkedAt < CACHE_TTL_MS) {
      fresh[id] = entry;
    } else {
      stale.push(id);
    }
  }
  return { fresh, stale };
}

async function storeCacheEntries(entries) {
  // entries: { [videoId]: { synthetic: boolean, method: "api"|"watch-page"|null } }
  const toStore = {};
  const checkedAt = Date.now();
  for (const [id, entry] of Object.entries(entries)) {
    toStore[CACHE_KEY_PREFIX + id] = { ...entry, checkedAt, schemaVersion: CACHE_SCHEMA_VERSION };
  }
  await chrome.storage.local.set(toStore);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Data API check (fast, cheap, first pass) — catches creator self-disclosure
// via `status.containsSyntheticMedia`. Does NOT catch YouTube's automatic
// AI-detection system (see the watch-page fallback below).
// ---------------------------------------------------------------------------

async function fetchSyntheticStatus(videoIds, apiKey) {
  // Returns { [videoId]: boolean }, throws { quotaExceeded: true } or { invalidKey: true } on failure.
  const results = {};
  const chunks = chunk(videoIds, CHUNK_SIZE);

  for (const ids of chunks) {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "status");
    url.searchParams.set("id", ids.join(","));
    url.searchParams.set("key", apiKey);

    const response = await fetch(url.toString());

    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch (_) {
        // ignore parse failure
      }
      const reason = body?.error?.errors?.[0]?.reason || "";

      if (response.status === 403 && reason === "quotaExceeded") {
        const err = new Error("quotaExceeded");
        err.quotaExceeded = true;
        throw err;
      }
      if (response.status === 400 || (response.status === 403 && reason === "keyInvalid")) {
        const err = new Error("invalidKey");
        err.invalidKey = true;
        throw err;
      }
      const err = new Error(`YouTube API error: ${response.status} ${reason}`);
      throw err;
    }

    const data = await response.json();
    const returnedIds = new Set();
    for (const item of data.items || []) {
      returnedIds.add(item.id);
      // containsSyntheticMedia is absent (not even `false`) for videos where
      // the creator never used the disclosure toggle — Boolean(undefined)
      // correctly treats "absent" the same as "false" here.
      results[item.id] = Boolean(item.status?.containsSyntheticMedia);
    }
    // Videos that no longer exist / are private won't be returned — treat as not synthetic.
    for (const id of ids) {
      if (!returnedIds.has(id)) {
        results[id] = false;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Watch-page fallback — catches YouTube's automatic AI-detection labeling,
// which is NOT exposed by the Data API. See README for background and
// maintenance notes: this relies on undocumented page structure.
// ---------------------------------------------------------------------------

function extractBalancedJson(text, startIdx) {
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(startIdx, i + 1);
      }
    }
  }
  return null;
}

function extractJsonAssignedTo(html, varName) {
  const patterns = [
    new RegExp(`var ${varName}\\s*=\\s*(\\{)`),
    new RegExp(`window\\["${varName}"\\]\\s*=\\s*(\\{)`),
    new RegExp(`window\\.${varName}\\s*=\\s*(\\{)`),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (!match) continue;
    const startIdx = match.index + match[0].length - 1;
    const json = extractBalancedJson(html, startIdx);
    if (json) return json;
  }
  return null;
}

// --- BUG A FIX: scope label search to the PRIMARY video's own subtree ------
//
// ytInitialData for a watch page also embeds full renderer data for the
// related-videos sidebar (`contents.twoColumnWatchNextResults.secondaryResults`).
// If ANY related video shown alongside the one being checked is itself
// AI-labeled, an unscoped recursive search over the whole object can match
// on that related video's data and produce a false positive for the primary
// video. Confirmed via scripts/inspect-watch-page.js against z8Dz-IFFFY4:
// the real signal lives exclusively at
//   ytInitialData.engagementPanels[5].engagementPanelSectionListRenderer
//     .content.structuredDescriptionContentRenderer.items[2]
//     .howThisWasMadeSectionViewModel
// i.e. under the top-level `engagementPanels` branch — a sibling of
// `contents`, never inside it. `engagementPanels`, the primary results
// column, `playerOverlays`, and `microformat` are all single-video
// structures that only ever describe the video the page was loaded for;
// `secondaryResults` is the only branch that describes *other* videos, so
// it is the only one that must be excluded.
const PRIMARY_VIDEO_SCOPE_PATHS = [
  ["engagementPanels"],
  ["contents", "twoColumnWatchNextResults", "results"], // NOT ...results.secondaryResults
  ["playerOverlays"],
  ["microformat"],
];

const DEBUG_SCOPING_KEY = "ytaif_debugScoping"; // toggle from any extension console:
// chrome.storage.local.set({ ytaif_debugScoping: true })

async function getDebugScopingEnabled() {
  const result = await chrome.storage.local.get(DEBUG_SCOPING_KEY);
  return Boolean(result[DEBUG_SCOPING_KEY]);
}

function getAtPath(obj, pathSegments) {
  let node = obj;
  for (const seg of pathSegments) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[seg];
  }
  return node;
}

// Structural signal discovered via scripts/inspect-watch-page.js: a
// `howThisWasMadeSectionViewModel` node appears in the structured
// description's engagement panel whenever YouTube shows a "How this was
// made" disclosure. Key presence alone is NOT sufficient, though — live
// testing found YouTube reuses this exact same container for at least two
// distinct disclosure types that share no other structure in common:
//   - "Altered or synthetic content" (support article 15447836) — what
//     this extension is meant to catch.
//   - Auto-dubbed audio tracks (support article 15569972, e.g. "Bazı
//     diller için ses parçaları otomatik olarak oluşturuldu") — a benign,
//     unrelated accessibility feature that is NOT what the "Yapay Zeka" /
//     "Altered or synthetic content" badge means, and must not be hidden.
// So every `howThisWasMadeSectionViewModel` node found is individually
// inspected for the specific support-article ID, rather than trusting the
// container key by itself. Never descends into a `secondaryResults`
// branch, even defensively, in case a future schema change nests one
// inside an otherwise-allowed root.
function findAllHowThisWasMadeNodes(node, path, results, depth = 0) {
  if (depth > 60 || !node || typeof node !== "object") return;
  if (!Array.isArray(node) && path[path.length - 1] === "secondaryResults") return;

  if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, "howThisWasMadeSectionViewModel")) {
    results.push({
      path: [...path, "howThisWasMadeSectionViewModel"].join("."),
      node: node.howThisWasMadeSectionViewModel,
    });
  }

  const entries = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node);
  for (const [key, value] of entries) {
    if (String(key) === "secondaryResults") continue; // belt-and-suspenders
    if (value && typeof value === "object") {
      findAllHowThisWasMadeNodes(value, [...path, String(key)], results, depth + 1);
    }
  }
}

// Checked ONLY within a single already-found howThisWasMadeSectionViewModel
// node's own text — never across a whole branch — so an unrelated match
// elsewhere on the page (e.g. a completely different "Yapay zeka" AI-chatbot
// disclaimer also living in engagementPanels) can't be mistaken for this
// node being the synthetic-content disclosure. See README for the concrete
// case that motivated this (a generic Turkish "AI" phrase colliding with an
// AI answers-panel disclaimer, unrelated to any video-content badge).
function nodeIsSyntheticContentDisclosure(node) {
  let text;
  try {
    text = JSON.stringify(node);
  } catch (_) {
    return false;
  }
  if (text.includes(AI_DISCLOSURE_SUPPORT_ARTICLE_ID)) return true;
  return AI_LABEL_PHRASES.some((phrase) => text.includes(phrase));
}

function findLabelMatchInScope(data, videoId, debug) {
  for (const scopePath of PRIMARY_VIDEO_SCOPE_PATHS) {
    const root = getAtPath(data, scopePath);
    if (!root) continue;

    const candidates = [];
    findAllHowThisWasMadeNodes(root, ["ytInitialData", ...scopePath], candidates);

    for (const candidate of candidates) {
      if (nodeIsSyntheticContentDisclosure(candidate.node)) {
        if (debug) {
          console.log(`[YT AI Filter][debug] ${videoId}: scoped JSON match (synthetic-content disclosure): ${candidate.path}`);
        }
        return candidate;
      }
      if (debug) {
        console.log(
          `[YT AI Filter][debug] ${videoId}: found howThisWasMadeSectionViewModel at ${candidate.path} but it's a ` +
            `different "How this was made" disclosure type (e.g. auto-dubbed audio) — not the synthetic-content badge, ignored.`
        );
      }
    }
  }
  return null;
}

// Debug-only sanity check: also runs the OLD unscoped search and warns if it
// would have matched inside secondaryResults — i.e. confirms the scope-leak
// class of bug is real and that the fix above correctly excludes it, without
// paying this extra recursive-walk cost during normal operation.
function debugCheckForScopeLeak(data, videoId) {
  const leaks = [];
  function walk(node, path, depth) {
    if (depth > 80 || !node || typeof node !== "object") return;
    if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, "howThisWasMadeSectionViewModel")) {
      if (path.includes("secondaryResults")) leaks.push(path.join("."));
    }
    const entries = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node);
    for (const [key, value] of entries) {
      if (value && typeof value === "object") walk(value, [...path, String(key)], depth + 1);
    }
  }
  walk(data, ["ytInitialData"], 0);
  if (leaks.length > 0) {
    console.warn(
      `[YT AI Filter][debug] ${videoId}: SCOPE LEAK — "howThisWasMadeSectionViewModel" also found inside ` +
        `secondaryResults at: ${leaks.join(", ")}. Correctly excluded from this video's verdict by the scoped search.`
    );
  }
}

function anyHowThisWasMadeNodeExistsInScope(data) {
  for (const scopePath of PRIMARY_VIDEO_SCOPE_PATHS) {
    const root = getAtPath(data, scopePath);
    if (!root) continue;
    const candidates = [];
    findAllHowThisWasMadeNodes(root, ["ytInitialData", ...scopePath], candidates);
    if (candidates.length > 0) return true;
  }
  return false;
}

// Strips secondaryResults out of a scoped subtree before it's stringified
// for the text fallback, so a related video's own disclosure text can never
// leak into the primary video's text-match search either.
function stripSecondaryResults(node, depth = 0) {
  if (depth > 60 || !node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((v) => stripSecondaryResults(v, depth + 1));
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "secondaryResults") continue;
    out[key] = stripSecondaryResults(value, depth + 1);
  }
  return out;
}

// Step 2 fallback: only used when NO howThisWasMadeSectionViewModel node
// exists anywhere in scope at all — i.e. a total schema change, the one
// scenario this fallback exists for. Deliberately narrower than an earlier
// version: it checks ONLY the specific support-article ID, not the generic
// phrase list. Searching a whole branch's stringified text for a broad
// phrase (rather than text scoped to one specific disclosure node) is
// exactly what caused the auto-dub/AI-chatbot false positives this fix
// addresses, so that broad phrase search is not repeated here.
function textFallbackMatchesScoped(data, videoId, debug) {
  let scopedText = "";
  for (const scopePath of PRIMARY_VIDEO_SCOPE_PATHS) {
    const root = getAtPath(data, scopePath);
    if (!root) continue;
    try {
      scopedText += JSON.stringify(stripSecondaryResults(root)) + "\n";
    } catch (_) {
      // ignore unstringifiable branch (e.g. circular ref), try the rest
    }
  }
  if (!scopedText) return false;

  const matched = scopedText.includes(AI_DISCLOSURE_SUPPORT_ARTICLE_ID);
  if (debug && matched) {
    console.log(`[YT AI Filter][debug] ${videoId}: scoped ID-only text fallback matched (no structural node was found at all).`);
  }
  return matched;
}

async function checkWatchPageForAILabel(videoId) {
  const debug = await getDebugScopingEnabled();
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`watch page fetch failed: ${response.status}`);
  }
  const html = await response.text();

  // Cheap early-out for the common case (most videos aren't labeled at all):
  // both Pass 2 signals are ultimately substring checks, so if neither the
  // support-article ID nor any known phrase appears anywhere in the raw HTML,
  // there's nothing to find and we skip extractBalancedJson + JSON.parse +
  // the deep clone in textFallbackMatchesScoped entirely. Note this checks
  // the raw (escaped) HTML, so it only stays valid for ASCII phrases —
  // a future non-ASCII AI_LABEL_PHRASES entry could appear as \uXXXX escapes
  // here and slip past this pre-filter even though it would match post-parse.
  if (
    !html.includes(AI_DISCLOSURE_SUPPORT_ARTICLE_ID) &&
    !AI_LABEL_PHRASES.some((phrase) => html.includes(phrase))
  ) {
    return false;
  }

  const rawJson = extractJsonAssignedTo(html, "ytInitialData");
  let data = null;
  if (rawJson) {
    try {
      data = JSON.parse(rawJson);
    } catch (_) {
      data = null;
    }
  }

  if (!data) {
    if (debug) {
      console.warn(
        `[YT AI Filter][debug] ${videoId}: could not parse ytInitialData — no subtree to scope to, ` +
          `returning false rather than falling back to an unscoped whole-page text search.`
      );
    }
    return false;
  }

  if (debug) debugCheckForScopeLeak(data, videoId);

  const jsonMatch = findLabelMatchInScope(data, videoId, debug);
  const textMatch =
    !jsonMatch && !anyHowThisWasMadeNodeExistsInScope(data) && textFallbackMatchesScoped(data, videoId, debug);
  const synthetic = Boolean(jsonMatch) || textMatch;

  if (debug) {
    console.log(
      `[YT AI Filter][debug] ${videoId}: synthetic=${synthetic} jsonMatchPath=${jsonMatch ? jsonMatch.path : null} textMatch=${textMatch}`
    );
  }

  return synthetic;
}

// ---------------------------------------------------------------------------
// Community channel-blocklist signal (AiSList) — periodic fetch/parse/cache.
// content.js pulls the parsed lists once at init via GET_CHANNEL_LISTS and
// does membership checks locally (a static Set lookup needs no round trip
// per card); this keeps "content.js never touches the network" intact since
// background still owns the fetch.
// ---------------------------------------------------------------------------

function parseAisListText(text) {
  const entries = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("!")) continue;
    // Handles are case-insensitive (@Handle === @handle) so normalize those;
    // channel IDs (UCxxxx) are case-sensitive base64url-ish strings — do not
    // touch their case, or exact matches in content.js would silently fail.
    entries.push(line.startsWith("@") ? line.toLowerCase() : line);
  }
  return entries;
}

async function fetchAisListFile(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`AiSList fetch failed: ${response.status} ${url}`);
  }
  const text = await response.text();
  return parseAisListText(text);
}

async function refreshChannelLists() {
  try {
    const [blocklist, warnlist] = await Promise.all([
      fetchAisListFile(AISLIST_BLOCKLIST_URL),
      fetchAisListFile(AISLIST_WARNLIST_URL),
    ]);
    await chrome.storage.local.set({
      [CHANNEL_LIST_KEY]: { blocklist, warnlist, fetchedAt: Date.now() },
    });
    console.log(
      `[YT AI Filter] AiSList refreshed: ${blocklist.length} blocklist / ${warnlist.length} warnlist entries.`
    );
  } catch (err) {
    console.error("[YT AI Filter] Failed to refresh AiSList channel lists:", err);
  }
}

async function getChannelLists() {
  const result = await chrome.storage.local.get(CHANNEL_LIST_KEY);
  return result[CHANNEL_LIST_KEY] || { blocklist: [], warnlist: [], fetchedAt: null };
}

async function ensureChannelListAlarm() {
  // chrome.alarms.create() resets an existing alarm's timer, and this file
  // re-runs every time the service worker wakes — so only create if it's not
  // already scheduled, or the periodic refresh would never actually fire.
  const existing = await chrome.alarms.get(CHANNEL_LIST_ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(CHANNEL_LIST_ALARM_NAME, { periodInMinutes: CHANNEL_LIST_REFRESH_MINUTES });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHANNEL_LIST_ALARM_NAME) {
    refreshChannelLists();
  }
});

ensureChannelListAlarm();
(async () => {
  const lists = await getChannelLists();
  if (!lists.fetchedAt) {
    // Cold install / cleared storage — don't wait for the first alarm tick.
    refreshChannelLists();
  }
})();

// --- Serial, rate-limited queue for watch-page fetches ---------------------

const watchQueue = []; // { videoId, resolve }
const queuedVideoIds = new Set(); // de-dupe: avoid queuing the same id twice
let activeFetches = 0;
let lastFetchStartedAt = 0;
let pumpScheduled = false;

function enqueueWatchPageCheck(videoId) {
  if (queuedVideoIds.has(videoId)) {
    // Already queued/in-flight — piggyback isn't wired up for simplicity,
    // caller will just get a fresh answer from cache next time. Skip.
    return Promise.resolve(null);
  }
  queuedVideoIds.add(videoId);
  return new Promise((resolve) => {
    watchQueue.push({ videoId, resolve });
    pumpQueue();
  });
}

async function pumpQueue() {
  if (pumpScheduled) return;
  if (activeFetches >= MAX_CONCURRENT_WATCH_FETCHES) return;
  if (watchQueue.length === 0) return;

  // Claim the slot BEFORE any await: runFallbackChecks enqueues synchronously
  // in a loop, so every call would otherwise clear the guards above (all
  // still false pre-await) and schedule its own timer — defeating both the
  // serial queue and the intensity spacing with a burst of concurrent fetches.
  pumpScheduled = true;

  const intensity = await getScanIntensity();
  if (intensity === "off") {
    pumpScheduled = false;
    while (watchQueue.length) {
      const job = watchQueue.shift();
      queuedVideoIds.delete(job.videoId);
      job.resolve(null); // null = "not checked" (distinct from a negative result)
    }
    return;
  }

  const spacing = SCAN_INTENSITY_SPACING_MS[intensity] || SCAN_INTENSITY_SPACING_MS.normal;
  const elapsed = Date.now() - lastFetchStartedAt;
  const wait = Math.max(0, spacing - elapsed);

  pumpScheduled = true;
  setTimeout(async () => {
    pumpScheduled = false;
    const job = watchQueue.shift();
    if (!job) return;

    queuedVideoIds.delete(job.videoId);
    activeFetches++;
    lastFetchStartedAt = Date.now();
    try {
      const synthetic = await checkWatchPageForAILabel(job.videoId);
      job.resolve(synthetic);
    } catch (err) {
      job.resolve(null); // treat fetch failures as "not checked", not "confirmed clean"
    } finally {
      activeFetches--;
      pumpQueue();
    }
  }, wait);
}

// ---------------------------------------------------------------------------
// Combined check: cheap API pass first, heavier watch-page fallback only for
// videos the API didn't already flag. The fallback runs asynchronously and
// reports back to the requesting tab via a push message once each result is
// ready, since the queue may take seconds to drain under rate limiting.
// ---------------------------------------------------------------------------

async function handleCheckVideos(videoIds, tabId) {
  const quotaUntil = await getQuotaExhaustedUntil();
  const apiKey = await getApiKey();
  const scanIntensity = await getScanIntensity();
  const pass1Enabled = await getPass1Enabled();

  const { fresh, stale } = await getCachedEntries(videoIds);
  const immediateSynthetic = new Set(
    Object.keys(fresh).filter((id) => fresh[id].synthetic)
  );

  let apiError = null;
  const pendingFallbackIds = [];

  if (stale.length > 0) {
    let apiResults = {};

    if (!pass1Enabled) {
      // User turned Pass 1 off entirely — skip the API call. Not an error
      // condition, so apiError stays null; ids fall through to the
      // scanIntensity check below exactly like the "no signal obtained" case.
    } else if (!apiKey) {
      apiError = "noApiKey";
    } else if (quotaUntil) {
      apiError = "quotaExceeded";
    } else {
      try {
        apiResults = await fetchSyntheticStatus(stale, apiKey);
      } catch (err) {
        if (err.quotaExceeded) {
          await setQuotaExhausted();
          apiError = "quotaExceeded";
        } else if (err.invalidKey) {
          apiError = "invalidKey";
        } else {
          apiError = "networkError";
        }
      }
    }

    const cacheWrites = {};
    for (const id of stale) {
      if (apiResults[id] === true) {
        cacheWrites[id] = { synthetic: true, method: "api" };
        immediateSynthetic.add(id);
      } else if (scanIntensity !== "off") {
        // API said false (or wasn't available) — worth a heavier look.
        pendingFallbackIds.push(id);
      } else if (apiResults[id] === false) {
        // API definitively checked and said no, and fallback is disabled —
        // safe to cache as a final negative.
        cacheWrites[id] = { synthetic: false, method: null };
      }
      // Otherwise: no signal at all was obtained (no key/quota exceeded AND
      // fallback off) — leave uncached so it's retried once settings change.
    }
    await storeCacheEntries(cacheWrites);
  }

  if (pendingFallbackIds.length > 0 && tabId != null) {
    runFallbackChecks(pendingFallbackIds, tabId);
  }

  return {
    synthetic: Array.from(immediateSynthetic),
    pending: pendingFallbackIds,
    error: apiError,
    quotaExhaustedUntil: quotaUntil,
  };
}

function runFallbackChecks(videoIds, tabId) {
  for (const videoId of videoIds) {
    enqueueWatchPageCheck(videoId).then(async (synthetic) => {
      if (synthetic === null) return; // not actually checked (queue drained / off / error)

      await storeCacheEntries({ [videoId]: { synthetic, method: synthetic ? "watch-page" : null } });

      if (synthetic) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            type: "SYNTHETIC_RESULT",
            videoId,
            method: "watch-page",
          });
        } catch (_) {
          // Tab navigated away/closed — nothing to update.
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Session counters (split by detection method, per Step 4)
// ---------------------------------------------------------------------------

async function incrementSessionCount(method) {
  const key = method === "watch-page" ? SESSION_SCAN_COUNT_KEY : SESSION_API_COUNT_KEY;
  const result = await chrome.storage.session.get(key);
  const current = result[key] || 0;
  await chrome.storage.session.set({ [key]: current + 1 });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CHECK_VIDEOS") {
    const tabId = sender.tab?.id ?? null;
    handleCheckVideos(message.videoIds || [], tabId)
      .then(sendResponse)
      .catch((err) => {
        console.error("[YT AI Filter] CHECK_VIDEOS failed:", err);
        sendResponse({ synthetic: [], pending: [], error: "internalError", quotaExhaustedUntil: null });
      });
    return true; // async response
  }

  if (message?.type === "INCREMENT_HIDDEN_COUNT") {
    incrementSessionCount(message.method).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "GET_STATUS") {
    (async () => {
      const apiKey = await getApiKey();
      const quotaUntil = await getQuotaExhaustedUntil();
      const local = await chrome.storage.local.get([FILTER_ENABLED_KEY, SCAN_INTENSITY_KEY, HIDE_MODE_KEY]);
      const filterEnabled = local[FILTER_ENABLED_KEY] !== false; // default true
      const scanIntensity = local[SCAN_INTENSITY_KEY] || "normal";
      const hideMode = local[HIDE_MODE_KEY] || "remove";
      const pass1Enabled = await getPass1Enabled();
      const channelBadgeEnabled = await getChannelBadgeEnabled();
      const channelLists = await getChannelLists();
      sendResponse({
        hasApiKey: Boolean(apiKey),
        quotaExhaustedUntil: quotaUntil,
        filterEnabled,
        scanIntensity,
        hideMode,
        pass1Enabled,
        channelBadgeEnabled,
        channelListFetchedAt: channelLists.fetchedAt,
        channelListCounts: {
          blocklist: channelLists.blocklist.length,
          warnlist: channelLists.warnlist.length,
        },
      });
    })();
    return true;
  }

  if (message?.type === "GET_CHANNEL_LISTS") {
    (async () => {
      const channelBadgeEnabled = await getChannelBadgeEnabled();
      const { blocklist, warnlist, fetchedAt } = await getChannelLists();
      sendResponse({ blocklist, warnlist, fetchedAt, channelBadgeEnabled });
    })();
    return true;
  }
});
