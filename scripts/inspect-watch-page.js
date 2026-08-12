#!/usr/bin/env node
// Standalone diagnostic script — NOT part of the extension bundle.
//
// Fetches a YouTube watch page, extracts the embedded ytInitialData JSON,
// and recursively searches it for keys/string values that look related to
// the "Altered or synthetic content" auto-detection label, so we can find
// the real JSON path YouTube uses for it (rather than guessing).
//
// Usage: node scripts/inspect-watch-page.js [videoId]

const VIDEO_ID = process.argv[2] || "z8Dz-IFFFY4";
const SEARCH_TERMS = ["synthetic", "altered", "yapay", "ai_generated", "disclosure"];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function extractJsonAssignedTo(html, varName) {
  // Matches: var ytInitialData = {...};  OR  window["ytInitialData"] = {...};
  const patterns = [
    new RegExp(`var ${varName}\\s*=\\s*(\\{)`),
    new RegExp(`window\\["${varName}"\\]\\s*=\\s*(\\{)`),
    new RegExp(`window\\.${varName}\\s*=\\s*(\\{)`),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (!match) continue;

    const startIdx = match.index + match[0].length - 1; // position of the opening `{`
    const json = extractBalancedJson(html, startIdx);
    if (json) return json;
  }
  return null;
}

// Walk forward from an opening brace, tracking string/escape state, until
// braces balance back to zero. Returns the raw JSON substring.
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

function matchesSearchTerms(str) {
  const lower = str.toLowerCase();
  return SEARCH_TERMS.some((term) => lower.includes(term));
}

function snippet(value, maxLen = 400) {
  let str;
  try {
    str = typeof value === "string" ? value : JSON.stringify(value);
  } catch (_) {
    str = String(value);
  }
  if (str.length > maxLen) str = str.slice(0, maxLen) + "…";
  return str;
}

function searchRecursive(node, path, results, seen) {
  if (node === null || node === undefined) return;

  if (typeof node === "string") {
    if (matchesSearchTerms(node)) {
      results.push({ path: path.join("."), match: "value", snippet: snippet(node) });
    }
    return;
  }

  if (typeof node !== "object") return;

  // Guard against cycles (shouldn't happen with JSON.parse output, but cheap to keep).
  if (seen.has(node)) return;
  seen.add(node);

  const entries = Array.isArray(node)
    ? node.map((v, i) => [i, v])
    : Object.entries(node);

  for (const [key, value] of entries) {
    const keyStr = String(key);
    const currentPath = [...path, keyStr];

    if (matchesSearchTerms(keyStr)) {
      results.push({
        path: currentPath.join("."),
        match: "key",
        snippet: snippet(value, 500),
      });
    }

    searchRecursive(value, currentPath, results, seen);
  }
}

async function main() {
  const url = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
  console.log(`Fetching ${url} ...`);

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  console.log(`HTTP status: ${response.status}`);
  const html = await response.text();
  console.log(`HTML length: ${html.length} chars`);

  const rawJson = extractJsonAssignedTo(html, "ytInitialData");
  if (!rawJson) {
    console.log("\n=== ytInitialData NOT FOUND in HTML ===");
    console.log("Falling back to plain-text substring search over raw HTML...\n");
    fallbackTextSearch(html);
    return;
  }

  console.log(`\nExtracted ytInitialData: ${rawJson.length} chars`);

  let data;
  try {
    data = JSON.parse(rawJson);
  } catch (err) {
    console.log("Failed to JSON.parse extracted ytInitialData:", err.message);
    console.log("\nFalling back to plain-text substring search over raw HTML...\n");
    fallbackTextSearch(html);
    return;
  }

  const results = [];
  searchRecursive(data, ["ytInitialData"], results, new Set());

  console.log(`\n=== ${results.length} match(es) found in ytInitialData ===\n`);
  for (const r of results) {
    console.log(`[${r.match}] ${r.path}`);
    console.log(`  ${r.snippet}\n`);
  }

  if (results.length === 0) {
    console.log("No matches in ytInitialData. Trying ytInitialPlayerResponse too...");
    const rawPlayerJson = extractJsonAssignedTo(html, "ytInitialPlayerResponse");
    if (rawPlayerJson) {
      try {
        const playerData = JSON.parse(rawPlayerJson);
        const playerResults = [];
        searchRecursive(playerData, ["ytInitialPlayerResponse"], playerResults, new Set());
        console.log(`\n=== ${playerResults.length} match(es) found in ytInitialPlayerResponse ===\n`);
        for (const r of playerResults) {
          console.log(`[${r.match}] ${r.path}`);
          console.log(`  ${r.snippet}\n`);
        }
        if (playerResults.length === 0) {
          console.log("No matches there either. Falling back to plain-text HTML search...\n");
          fallbackTextSearch(html);
        }
      } catch (err) {
        console.log("Failed to parse ytInitialPlayerResponse:", err.message);
        fallbackTextSearch(html);
      }
    } else {
      console.log("ytInitialPlayerResponse not found either. Falling back to plain-text HTML search...\n");
      fallbackTextSearch(html);
    }
  }
}

function fallbackTextSearch(html) {
  const phrases = [
    "Altered or synthetic content",
    "Yapay zeka",
    "ile deÄŸiÅŸtirildi", // decomposed defensively; real check should use the actual UTF-8 string
  ];
  for (const phrase of phrases) {
    const idx = html.indexOf(phrase);
    if (idx === -1) {
      console.log(`NOT FOUND: "${phrase}"`);
    } else {
      const start = Math.max(0, idx - 150);
      const end = Math.min(html.length, idx + phrase.length + 150);
      console.log(`FOUND: "${phrase}" at index ${idx}`);
      console.log(`  context: ...${html.slice(start, end).replace(/\s+/g, " ")}...\n`);
    }
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
