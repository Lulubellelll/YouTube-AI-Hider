# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome extension that hides YouTube videos labeled as "Altered or
synthetic content" (via YouTube's own creator-disclosure and auto-detection
signals), and separately — never via the same code path — flags videos from
channels a community-maintained list associates with AI-generated content.
No build step, no bundler, no package.json, no test suite — the source files
*are* the extension. Edit a file and reload the extension.

## Commands

There is no build, lint, or test command. Development is manual:

```bash
node scripts/inspect-watch-page.js z8Dz-IFFFY4
```

`scripts/inspect-watch-page.js` is a standalone Node diagnostic (not part of the
extension bundle). It fetches a watch page, extracts `ytInitialData`, and dumps
every path matching `synthetic|altered|yapay|ai_generated|disclosure`. This is
the tool for re-deriving the detection signal after a YouTube frontend change.
`z8Dz-IFFFY4` is the known AI-labeled calibration video; `dQw4w9WgXcQ` is the
known-clean control.

Loading and reloading:

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. After any source edit: click refresh on the extension card, **then reload
   open YouTube tabs** (the content script only initializes on page load).

Two separate consoles matter, and they show different halves of the flow:

- YouTube tab DevTools console → content-script logs, prefixed `[YouTube AI Filter]`.
- `chrome://extensions` → **service worker** link → background logs, including
  all watch-page fetch activity.

Verbose detection tracing is off by default. Enable from either console:

```js
chrome.storage.local.set({ ytaif_debugScoping: true })
```

This turns on per-node match logging plus `debugCheckForScopeLeak`, which
re-runs the old *unscoped* search and warns when a related-video disclosure
would have leaked into the verdict.

Force a check of a specific video from a YouTube tab console:

```js
chrome.runtime.sendMessage({ type: "CHECK_VIDEOS", videoIds: ["z8Dz-IFFFY4"] }, console.log)
```

Investigating a specific report of "this video shouldn't be hidden but is" — three checks,
in order of how fast they narrow it down:

1. **Neither hide mode detaches the card**, so one query lists what's hidden regardless of
   the "Hide mode" popup setting (`ytaif_hideMode` in `chrome.storage.local`, `"remove"`
   (default) or `"overlay"` — read once at content-script init via `GET_STATUS` and kept
   live via a `storage.onChanged` listener, so switching it in the popup takes effect on
   the next check without a reload):
   ```js
   [...document.querySelectorAll('[data-ytaif-hidden="true"]')].map(el => ({
     id: el.getAttribute('data-ytaif-video-id'),
     method: el.getAttribute('data-ytaif-hidden-method'), // "api" (Pass 1) | "watch-page" (Pass 2)
     style: el.getAttribute('data-ytaif-hide-style'),     // "removed" | "overlay"
   }))
   ```
   `window.__ytaifRemoved` is still maintained as a `videoId -> method` map for cards
   hidden in `"remove"` mode specifically:
   ```js
   [...window.__ytaifRemoved.entries()]
   ```
   In `"overlay"` mode the overlay text also distinguishes the pass: plain "AI-labeled" is
   Pass 1, "(auto-detect)" is Pass 2. If the reported video ID isn't in the list, it wasn't
   hidden by this extension on the current page load — the report was either about a
   different card than the user thinks, or (since these are cleared by any reload) about a
   previous page load.

   **`"remove"` mode hides via the `.ytaif-removed` CSS class (`display: none`), never
   `card.remove()`.** This is load-bearing, not stylistic — see `applyRemovedStyle` in
   `content.js` for the full rationale. Detaching the element caused two failures that
   `"overlay"` mode never hit, which is why remove mode appeared broken while labelling
   worked: it bailed out on `!card.isConnected` (YouTube detaches and re-attaches feed
   cards while the page is still streaming, so a card detached at verdict time was
   silently never hidden and never retried, since it already carried
   `data-ytaif-processed`), and it fought `ytd-rich-grid-renderer`, which still owns the
   card. Verified live that `display: none` reflows the grid identically to removal — no
   gaps, rows stay full.

   Because the element survives, both directions of a live mode switch now work
   (`convertHiddenCardsToMode`), and disabling the filter restores cards in **both** modes.
2. Check the cached verdict directly: `chrome.storage.local.get("ytaif_cache_<videoId>", console.log)`.
   `method` tells you which pass wrote it; `schemaVersion` must match `CACHE_SCHEMA_VERSION`
   in `background.js` or the entry is stale and ignored.
3. Force a fresh live check with the `CHECK_VIDEOS` snippet above — bypasses nothing, so a
   `synthetic: []` result means both passes currently agree the video is clean.

Note that a card, once hidden, is **not** automatically re-verified — a still-enabled
filter never re-evaluates a card it already hid, in either hide mode. Disabling the filter
mid-session *does* restore every hidden card now that neither mode detaches the element
(`applyFilterEnabledState` calls `unhideCard` on everything carrying
`data-ytaif-hidden="true"`), but nothing re-checks a card whose verdict later flips to
negative. So "it was hidden, now the diagnostics all say clean" is an expected combination,
not a contradiction: whatever produced the original (possibly wrong, possibly just
slow-to-settle) verdict is long gone by the time you look.

## Architecture

### Two-pass detection, and why the second pass exists

The whole design follows from one fact: `status.containsSyntheticMedia` (Data
API v3) is **only** set when a creator manually ticks the disclosure toggle in
Studio. YouTube's automatic AI-detection labeling — rolled out May 2026, and
visible in YouTube's own UI — is *not* written back to that field. It is absent
entirely, not `false`. So the API alone misses most labeled videos.

- **Pass 1** (`fetchSyntheticStatus`) — batched `videos.list?part=status`, up to
  50 IDs per call, ~1 quota unit per call regardless of batch size. Cheap.
  Catches creator self-disclosure only.
- **Pass 2** (`checkWatchPageForAILabel`) — fetches the actual watch page HTML
  and searches the embedded `ytInitialData` for the disclosure panel. Catches
  auto-detection. Expensive, rate-limited, and built on undocumented page
  structure that WILL break without notice.

Pass 2 only runs for videos Pass 1 didn't flag, and only for cards the user
actually scrolled to.

### Process boundaries

`content.js` never touches the network. It finds cards, sends `CHECK_VIDEOS` to
the background worker, and hides what comes back. All fetching, caching, quota
tracking and rate limiting live in `background.js`. This split is deliberate —
keep it.

Message types (all in `background.js`'s `onMessage` listener):

- `CHECK_VIDEOS` (content → bg) — returns `{ synthetic, pending, error, quotaExhaustedUntil }`
  *synchronously-ish*; `pending` IDs are queued for Pass 2 and answered later.
- `SYNTHETIC_RESULT` (bg → content, pushed) — a late Pass 2 hit. Only ever sent
  for positives. The content script resolves it to a card via `resolveCardsForVideoId`,
  not a plain `cardsById` lookup — see below.
- `INCREMENT_HIDDEN_COUNT`, `GET_STATUS`, `GET_CHANNEL_LISTS` (the last one is
  for the community channel-blocklist signal — see its own section below).

The push-back channel exists because the Pass 2 queue can take seconds to drain,
long after the original `CHECK_VIDEOS` response was sent.

`content.js` also receives data from a *second, separate* content script
(`channel-data-relay.js`) that isn't `chrome.runtime` messaging at all — it's a
`window` `CustomEvent`, because that script runs in the page's main world and
has no access to `chrome.*` APIs. See the community channel-blocklist
section's cross-world bridge explanation below before touching either file.

### Resolving a verdict back to its card

`cardsById` maps `videoId -> WeakRef(card)`, not a plain strong reference — and
looking one up (`resolveCardsForVideoId` in `content.js`) always unions that with
a live `document.querySelectorAll('[data-ytaif-video-id="..."]')`, rather than
trusting either source alone. Both halves are load-bearing:

- The DOM query is the authority on what's on the page *now*. It finds a card
  whose Map entry is gone (garbage-collected, or the element was re-created by
  YouTube), and it finds the same video shown on more than one card, which a
  `videoId -> single card` Map can't represent.
- The Map entry covers the case the DOM query misses: `ytd-rich-grid-renderer`
  detaches and re-attaches feed cards during streaming/re-layout, so at the
  instant a late Pass 2 verdict arrives the card can be mid-detach — invisible
  to `querySelectorAll` — while still alive and about to be put back.

`WeakRef`, not a strong reference, because YouTube drops feed cards for good as
the page grows; a strong Map would pin every one of their subtrees for the life
of the page. Dead entries are cleaned up by a `FinalizationRegistry` callback
registered alongside each `WeakRef`, not by a periodic sweep — an earlier
version walked the entire `cardsById` map every `PRUNE_INTERVAL_CARDS`
newly-scanned cards, which looked amortized but wasn't: the map only grows
over a session (an entry disappears only via GC, which is rare while a card
is still reachable), so each sweep cost O(current map size) and the sweeps
kept coming — O(N²) over a long scroll session, and the actual cause of the
reported "gets slower the longer you scroll" behavior. The
registry callback double-checks that the entry it's about to delete still
points to the *collected* ref before deleting — a videoId can be
re-registered to a newer card before the old one's callback fires, and that
entry must survive. **Do not** revive the old pattern of deleting an entry
because `!card.isConnected`: that was a separate, earlier bug (see the
`"remove"` mode section above) — a momentarily detached card is not a dead
card, and treating it as one drops the verdict permanently, in either hide
mode.

### The Pass 2 verdict logic — three subtleties that are all load-bearing

These each fix a real, observed false positive. Don't "simplify" them away.

1. **Scope to the primary video.** A watch page's `ytInitialData` embeds the
   full sidebar of related videos under
   `contents.twoColumnWatchNextResults.secondaryResults`. An unscoped recursive
   search matches a *related* video's label and produces a false positive for
   the video being checked. `PRIMARY_VIDEO_SCOPE_PATHS` whitelists the four
   single-video branches; `secondaryResults` is excluded three separate times
   (scope path, early return, per-key skip) on purpose.

2. **Key presence is not sufficient.** YouTube reuses
   `howThisWasMadeSectionViewModel` for at least two unrelated disclosures:
   synthetic content (support article **15447836**) and auto-dubbed audio tracks
   (article 15569972). Auto-dub is a benign accessibility feature and must not
   be hidden. So every found node is individually inspected for the specific
   article ID — see `nodeIsSyntheticContentDisclosure`.

3. **Text matching is scoped to a single node, never a branch.** Broad
   phrase-matching across stringified branches is what caused the original false
   positives (a generic Turkish "Yapay zeka" string matched an unrelated AI
   answers-panel disclaimer). `textFallbackMatchesScoped` therefore runs *only*
   when no `howThisWasMade` node exists anywhere in scope — a total schema
   change — and checks the article ID alone, never the phrase list.

`AI_DISCLOSURE_SUPPORT_ARTICLE_ID` is the reliable signal: it's a URL segment,
so it's locale-independent. `AI_LABEL_PHRASES` in `label-strings.js` is a
secondary confirmation only. Before adding a locale phrase there, verify it
against a real node's `bodyText.content` via the diagnostic script — a wrong
phrase causes false positives, a missing one costs nothing.

`checkWatchPageForAILabel` opens with a cheap early-out: if neither the
article ID nor any `AI_LABEL_PHRASES` entry appears anywhere in the *raw*
HTML response, it returns `false` before running `extractBalancedJson`,
`JSON.parse`, or the branch-stringifying in `textFallbackMatchesScoped` —
skips the expensive path for the common case of an unlabeled video. This
checks the raw (JS-string-escaped) HTML, not the parsed JSON, so it's only
sound for ASCII phrases — a non-ASCII locale phrase could appear as `\uXXXX`
escapes in the raw HTML and slip past this pre-filter while still matching
after `JSON.parse`. `AI_LABEL_PHRASES` is English-only today; if a non-ASCII
phrase is ever added back, this early-out needs to search the phrase's
escaped form too (or be removed for that phrase).

### Caching

Entries are `ytaif_cache_<videoId>` in `chrome.storage.local`, 7-day TTL, shared
by both passes. **`CACHE_SCHEMA_VERSION` must be bumped whenever the Pass 2
verdict logic changes in a way that could flip a past result.** Entries written
under an older version are treated as stale regardless of TTL, so a logic fix
takes effect immediately instead of waiting out up to 7 days of wrong cached
verdicts.

Negative results are cached too — but note the asymmetry in `handleCheckVideos`:
a video is only cached as a *final* negative when a pass definitively said no.
If no signal was obtainable at all (no API key or quota exhausted, *and* scan
intensity is off), it's deliberately left uncached so it gets retried once
settings change.

### Rate limiting

Watch-page fetches go through a single queue in `background.js` with spacing set
by the scan intensity setting (`off` / `normal` ~500ms / `thorough` ~1200ms).
"Thorough" means *more patient*, not faster or more concurrent. Cards are only
queued once they intersect the viewport (200px look-ahead), never the whole feed
upfront. Treat the politeness of this queue as a hard requirement, not a tunable
— it's fetching real page loads against YouTube, not a metadata endpoint.

`pumpQueue()` sets `pumpScheduled = true` *before* its first `await`
(`getScanIntensity()`). This is required, not incidental: `runFallbackChecks`
enqueues a whole batch synchronously in a loop, so if the flag were set after
an await, every call in that loop would see `pumpScheduled === false` and each
would schedule its own timer — a burst of concurrent fetches that silently
breaks both the "serial" guarantee and the intensity spacing. If you touch
this function, keep the synchronous guard-claim ahead of any `await`.

On the content-script side, `scanForCards(root)` must only scan `root` itself
plus its descendants — never a wider ancestor. Infinite scroll adds cards
one mutation at a time; scanning outward from each one (e.g. `parentElement`
or `document.body`) means re-querying every card loaded so far per addition,
which is quadratic over a long scroll session. The mutation observer batches
same-frame additions via `requestAnimationFrame` before calling this, so it's
called once per frame with only the newly-added nodes, not on every mutation.

### Current scope

Homepage feed, the watch-page sidebar (related videos), and search results.
`CARD_SELECTOR` matches `ytd-rich-item-renderer` (homepage grid wrapper),
`yt-lockup-view-model` (bare, on the sidebar — same component the homepage
wrapper contains internally), and `ytd-video-renderer` (search results page).
`findFeedContainer` resolves one container per page type, **branching on
`location.pathname` first**: `ytd-rich-grid-renderer` on the homepage/feeds,
`ytd-section-list-renderer` on `/results`, `ytd-watch-next-secondary-results-renderer`
on `/watch`, each falling back to `document.body`.

Do not turn this back into an ordered chain of global `querySelector` calls. Confirmed
live: `ytd-watch-next-secondary-results-renderer` is part of YouTube's persistent
`ytd-app` shell and is present in the DOM on *every* page type, not just watch pages.
The previous fallback chain therefore matched it on a search results page — before
`ytd-section-list-renderer` was ever tried — and bound the mutation observer to an
unrelated empty container, so **search results were never scanned at all**, in either
hide mode. (Verified: that element does not contain the page's `ytd-video-renderer`
cards; `ytd-section-list-renderer` does.)

`scanForCards` skips a `CARD_SELECTOR` match that's nested
inside another match, so a future layout where one of these selectors nests
another can't double-process the same physical card.

The sidebar's Shorts shelf, and the search page's Shorts shelf, both use an
unrelated tag (`ytm-shorts-lockup-view-model`, or the `-v2` variant on search)
and are naturally excluded — no special-casing needed. A search page's
promoted-video ad (`ytd-search-pyv-renderer`) is *not* excluded — its inner
`yt-lockup-view-model` isn't nested inside any `CARD_SELECTOR` ancestor, so it
gets scanned and checked like any other card. This matches existing behavior
for homepage in-feed ads, which are wrapped in a real `ytd-rich-item-renderer`
and were already being scanned before this change — ads are not special-cased
anywhere in this codebase. Other search result types (channels, playlists) use
different renderers entirely and are correctly ignored.

This also covers SPA navigation. YouTube swaps the DOM client-side when you
click a video, run a search, click a search result, or click the logo to
return to the homepage — no full page reload, so `content.js`'s one-time
`document_idle` init never runs again. Left alone, the mutation observer
would keep watching whatever container it was bound to at that first load,
which YouTube may detach entirely on the next in-app navigation (e.g. the
watch page's sidebar container isn't part of the homepage) — cards on the
new page would then land in a container the observer was never watching and
would silently never get scanned. `bindFeedObserver()` in `content.js` is
called again on every `yt-navigate-finish` event (fired on `document` after
every SPA navigation completes, by which point the new page's containers
already exist) to re-derive the container via `findFeedContainer()` and
rebind. It skips the rebind (but still scans) when the freshly-resolved
container is the *same* element as before — this happens when both
resolutions fell back to `document.body` because the page's own container
hadn't been created yet, and an observer already watching all of `body` has
nothing to gain from disconnecting and reconnecting to itself.

The community channel-blocklist signal below covers this same set of cards,
but resolves channel identity through a different mechanism per page type —
see its own section rather than assuming it follows `CARD_SELECTOR`/
`findFeedContainer` exactly.

## Community channel-blocklist signal (AiSList)

A third, independent signal — deliberately **not** a third pass in the
two-pass sequence above, and it never hides or removes anything. Pass 1 and
Pass 2 both only ever relay YouTube's *own* stated verdict (creator
disclosure, or YouTube's own auto-detect label), which is what makes them
safe to hide on. [AiSList](https://github.com/Override92/AiSList) is a
community-maintained, crowd-sourced list of channels that mostly post
AI-generated content — useful for recall, but it can go stale (a channel that
reforms or renames stays listed indefinitely per the source's own docs) and
it's a third-party judgment, not YouTube's. So it only ever attaches a small,
non-blocking "possibly AI (community-flagged)" corner badge
(`.ytaif-community-badge` in `content.css`) to a still-fully-visible,
still-clickable card. **Do not** wire this into
`hideCard`/`applyRemovedStyle`/overlay code, and do not set `HIDDEN_ATTR`
from it — keeping that boundary is the entire point of this being a separate
signal. CC BY-NC 4.0 — attribution lives in the popup.

`background.js` fetches `aislist_blocklist.txt` (high confidence) and
`aislist_warnlist.txt` (lower confidence) from
`raw.githubusercontent.com/Override92/AiSList` every 12h via `chrome.alarms`
(`ytaif-refresh-channel-lists`; the `alarms` permission and the
`raw.githubusercontent.com` host permission exist for exactly this), plus an
eager fetch on cold install/empty cache. Parsed into `ytaif_channelLists`
(`{ blocklist, warnlist, fetchedAt }`, both arrays of `@handle`/`UCxxxx`
strings). **Only `@handle` entries are lowercased on parse**
(`parseAisListText`) — YouTube handles are case-insensitive, but `UC...`
channel IDs are case-sensitive base64url-ish strings, and lowercasing one
silently breaks exact-match lookup.

`content.js` pulls the parsed lists once via `GET_CHANNEL_LISTS` at init,
builds two local `Set`s, and does an O(1) local lookup per card — no per-card
network round trip, unlike Pass 1/2. `ytaif_pass1Enabled` and
`ytaif_channelBadgeEnabled` gate Pass 1 and the badge independently from the
popup; Pass 2's on/off is still just `scanIntensity === "off"` — no separate
key for it, to avoid two sources of truth for the same thing.

### The cross-world bridge — the whole reason `channel-data-relay.js` exists

The watch-page sidebar's compact `yt-lockup-view-model` cards render the
channel name as **plain text, with no link at all** — confirmed live.
Homepage/search cards use a different ("vertical") layout variant that does
render a real `/@handle` or `/channel/UC...` anchor (`CHANNEL_LINK_SELECTOR`
in `content.js` covers those two page types; it will always return `null` on
the sidebar). So sidebar coverage needs an entirely different source.

That source exists: the sidebar's Polymer ancestor
(`ytd-item-section-renderer`) still holds the *un-rendered* API response on a
`.data.contents[]` property, and each entry's `lockupViewModel.contentId`
equals the video ID — match by video ID, not array index, since order isn't
guaranteed to track render order once `continuationItemRenderer` entries
interleave. The channel's `browseEndpoint` (both `canonicalBaseUrl` and
`browseId`) lives at
`lockupViewModel.metadata.lockupMetadataViewModel.image.decoratedAvatarViewModel.rendererContext.commandContext.onTap.innertubeCommand.browseEndpoint`.

**But `content.js` cannot read `.data` — this cost real debugging time,
twice, before the actual cause was found, so don't re-litigate it.** `.data`
is a plain JS property Polymer's own (main-world) code sets on the element;
it is not a real DOM attribute. Chrome content scripts run in an *isolated
world* by default: real DOM (structure, attributes, layout, `closest()`,
`querySelector`) is shared with the page, but each world gets its own
wrapper object per DOM node, so an expando property set by one world's
script is invisible from the other. Confirmed by hand: `.data` reads as
`undefined` from an isolated-world script on a node whose `.data` a
main-world script reads fine — every time, regardless of timing. (An earlier
fix attempt wrongly assumed this was a detach/re-attach timing race — the
same class of issue `resolveCardsForVideoId` exists to handle elsewhere — and
deferred the check to `IntersectionObserver`. Harmless to keep, but it fixed
nothing, because it was never a timing bug.)

The actual fix: `channel-data-relay.js`, declared as a **second, separate
content script** in `manifest.json` with `"world": "MAIN"`. It runs in the
same world as YouTube's own code, so `.data` *is* visible there — it does the
`.data.contents[]` walk and republishes the result as a real DOM attribute
(`data-ytaif-channel-bridge`), which — being part of the actual DOM, not an
expando — is visible from `content.js`'s isolated world via a plain
`getAttribute`. `content.js` never touches `.data` directly; all of that
lookup logic lives only in `channel-data-relay.js`, deliberately duplicated
rather than shared, since the two scripts run in different worlds and can't
share a closure, and this is a no-build-step extension.

Because a main-world script has **no access to `chrome.*` APIs at all**, it
can't message `content.js` via `chrome.runtime` either — it dispatches a
plain `CustomEvent` (`ytaif-channel-bridge-update`) on `window` instead
(shared DOM ⇒ visible to both worlds), which `content.js` listens for to
retroactively badge a card whose bridge attribute lands just after its own
`IntersectionObserver`-triggered check already ran and found nothing.

If this breaks: `scripts/inspect-watch-page.js` won't help here — that
diagnoses Pass 2's `ytInitialData`, a different object entirely. Instead,
load a watch page and, from a normal (main-world by default) DevTools
console, walk `document.querySelector('yt-lockup-view-model').closest('ytd-item-section-renderer').data`
to find where `contentId`/`browseEndpoint` moved.

### Diagnosing a missing badge

```js
[...document.querySelectorAll('[data-ytaif-video-id]')].map(c => ({
  videoId: c.getAttribute('data-ytaif-video-id'),
  bridgeAttr: c.getAttribute('data-ytaif-channel-bridge'), // sidebar cards only — see above
  channel: c.getAttribute('data-ytaif-channel'),           // set once content.js resolves either source
  flag: c.getAttribute('data-ytaif-community-flag'),       // "blocklist" | "warnlist" | absent
}))
```

- `channel` null → extraction failed. On homepage/search that means
  `CHANNEL_LINK_SELECTOR` didn't match; on the sidebar, check `bridgeAttr`
  first — if that's also null, `channel-data-relay.js` (main world) hasn't
  run yet or found nothing for that video.
- `channel` set but `flag` null → the card's channel genuinely isn't on
  either list. Not a bug — check `chrome.storage.local.get('ytaif_channelLists')`
  directly against the specific handle/ID if unsure.
- Both set but no visible badge → check `ytaif_channelBadgeEnabled`, and that
  `THUMBNAIL_CONTAINER_SELECTOR` matched (the badge anchors there, same
  container the overlay uses).

Also worth knowing from live-debugging this feature: reloading the extension
card at `chrome://extensions` does not reliably guarantee a stale content
script is gone from an already-open tab. `chrome.runtime.getManifest().version`
in a YouTube tab's console is the one unambiguous way to confirm which build
is actually running — bump `version` in `manifest.json` on any change whose
effect would otherwise be hard to distinguish from a stale reload.

## Expect Pass 2 to break

It depends on undocumented internal page structure. When it silently stops
matching, the recovery loop is: run `scripts/inspect-watch-page.js` against a
known AI-labeled video, find where the disclosure moved, update the key name /
article ID / scope paths, then bump `CACHE_SCHEMA_VERSION`. Pass 1 is unaffected
by any of this and keeps working regardless.
