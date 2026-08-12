// Runs in the MAIN world (see manifest.json's "world": "MAIN" on this
// script's content_scripts entry) — unlike content.js, which runs in the
// default isolated world and has no visibility into this file's variables,
// or vice versa. That split exists for exactly one reason:
//
// The watch-page sidebar's compact yt-lockup-view-model cards render no
// channel link at all (see content.js's CHANNEL_LINK_SELECTOR comment), but
// their Polymer ancestor (ytd-item-section-renderer) still holds the full,
// un-rendered response on a `.data.contents[]` array. That property is a
// plain JS expando set by YouTube's own main-world code — isolated worlds
// share the real DOM (structure, attributes, layout) with the page, but
// each world gets its own wrapper object per DOM node, so an expando set by
// another world's script is invisible from here. content.js confirmed this
// by hand: `.data` reads as undefined there on a node whose `.data` is
// readable fine from this world, for every card, regardless of timing.
//
// This script's only job is to cross that boundary: read `.data` where it's
// visible (here), and republish the result as a REAL DOM attribute, which —
// unlike an expando — is part of the actual DOM and so IS visible from
// content.js's isolated world via a plain getAttribute.
//
// This has no access to chrome.* APIs (main-world scripts don't), so it
// can't message content.js directly either; it dispatches a CustomEvent on
// window instead, which both worlds can listen to since it's dispatched
// through the DOM they share.
(() => {
  const LOCKUP_CHANNEL_BROWSE_ENDPOINT_PATH = [
    "metadata",
    "lockupMetadataViewModel",
    "image",
    "decoratedAvatarViewModel",
    "rendererContext",
    "commandContext",
    "onTap",
    "innertubeCommand",
    "browseEndpoint",
  ];
  const BRIDGE_ATTR = "data-ytaif-channel-bridge";
  const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
  const CARD_SELECTOR = "yt-lockup-view-model"; // only card type missing a rendered channel link — see content.js

  function getAtPath(obj, path) {
    let node = obj;
    for (const key of path) {
      if (node == null || typeof node !== "object") return undefined;
      node = node[key];
    }
    return node;
  }

  // Deliberately duplicated from content.js rather than shared: these two
  // files run in different worlds and can't share a module/closure, and
  // this is small enough that a shared-file build step isn't worth it for
  // a no-build-step extension.
  function extractVideoId(card) {
    const anchor = card.querySelector('a#thumbnail[href^="/watch?v="], a[href^="/watch?v="]');
    if (!anchor) return null;
    try {
      const url = new URL(anchor.href, location.origin);
      const id = url.searchParams.get("v");
      if (id && VIDEO_ID_RE.test(id)) return id;
    } catch (_) {
      return null;
    }
    return null;
  }

  function normalizeBrowseEndpoint(browseEndpoint) {
    if (!browseEndpoint) return null;
    if (typeof browseEndpoint.canonicalBaseUrl === "string") {
      const handleMatch = browseEndpoint.canonicalBaseUrl.match(/^\/(@[\w.-]+)/);
      if (handleMatch) return handleMatch[1].toLowerCase();
    }
    if (typeof browseEndpoint.browseId === "string" && browseEndpoint.browseId.startsWith("UC")) {
      return browseEndpoint.browseId;
    }
    return null;
  }

  // Matched by video ID, not array index: order isn't guaranteed to track
  // render order (continuationItemRenderer entries interleave) — confirmed
  // live that `lockupViewModel.contentId` equals the video ID.
  function resolveChannelForCard(card, videoId) {
    const section = card.closest("ytd-item-section-renderer, ytd-watch-next-secondary-results-renderer");
    const contents = section?.data?.contents;
    if (!Array.isArray(contents)) return null;
    const entry = contents.find((c) => c?.lockupViewModel?.contentId === videoId);
    const browseEndpoint = getAtPath(entry?.lockupViewModel, LOCKUP_CHANNEL_BROWSE_ENDPOINT_PATH);
    return normalizeBrowseEndpoint(browseEndpoint);
  }

  function processCard(card) {
    if (card.hasAttribute(BRIDGE_ATTR)) return;
    const videoId = extractVideoId(card);
    if (!videoId) return;
    const channelId = resolveChannelForCard(card, videoId);
    if (!channelId) return;
    card.setAttribute(BRIDGE_ATTR, channelId);
    window.dispatchEvent(new CustomEvent("ytaif-channel-bridge-update", { detail: { videoId } }));
  }

  function scan(root) {
    const cards = [];
    if (root.matches && root.matches(CARD_SELECTOR)) cards.push(root);
    if (root.querySelectorAll) cards.push(...root.querySelectorAll(CARD_SELECTOR));
    for (const card of cards) processCard(card);
  }

  // Same rAF-batching shape as content.js's own mutation observer, for the
  // same reason: only scan newly-added subtrees, never a wider ancestor, or
  // this becomes the same quadratic-over-a-long-scroll-session bug content.js
  // already had to fix once (see its cardsById comment).
  let scanScheduled = false;
  const pendingRoots = new Set();
  function scheduleScan(root) {
    pendingRoots.add(root);
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      const roots = Array.from(pendingRoots);
      pendingRoots.clear();
      for (const r of roots) scan(r);
    });
  }

  function start() {
    // Scoped to the sidebar container specifically (falling back to
    // document.body only if it's not there yet) — this bridge only matters
    // on /watch pages, homepage/search cards already get a real channel
    // link (see content.js's CHANNEL_LINK_SELECTOR).
    const container = document.querySelector("ytd-watch-next-secondary-results-renderer") || document.body;
    scan(container); // cards already present at script-load time
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if ((node.matches && node.matches(CARD_SELECTOR)) || node.querySelector?.(CARD_SELECTOR)) {
            scheduleScan(node);
          }
        }
      }
    }).observe(container, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
