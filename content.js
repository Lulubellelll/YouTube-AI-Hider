// Content script: runs on https://www.youtube.com/*
// Finds video cards in the homepage feed and the watch-page sidebar (related
// videos), asks background.js which are labeled as synthetic/altered media,
// and hides those cards — either by removing them outright or by overlaying
// a click-to-reveal label, per the "Hide mode" popup setting.
//
// Cards are only queued for checking once they actually scroll into view
// (IntersectionObserver) — the watch-page fallback check in background.js
// is comparatively expensive, so we don't want to eagerly check an entire
// feed's worth of videos the user may never scroll to.

(() => {
  const PROCESSED_ATTR = "data-ytaif-processed";
  const VIDEO_ID_ATTR = "data-ytaif-video-id"; // stamped on every scanned card; also the recovery key for a late verdict
  const HIDDEN_ATTR = "data-ytaif-hidden"; // set in BOTH hide modes — neither mode detaches the card
  const HIDDEN_METHOD_ATTR = "data-ytaif-hidden-method"; // "api" | "watch-page" — set alongside HIDDEN_ATTR so a later mode switch can convert without re-deriving how it was caught
  const HIDE_STYLE_ATTR = "data-ytaif-hide-style"; // "removed" | "overlay" — which presentation is currently applied
  const CHANNEL_ATTR = "data-ytaif-channel"; // normalized channel handle/ID stamped at scan time, if one was found
  const CHANNEL_BADGE_ATTR = "data-ytaif-community-flag"; // "blocklist" | "warnlist" — set ONLY by the community signal below, never by Pass 1/2. This is a separate, non-blocking annotation: it must never be read or written by hideCard/applyRemovedStyle/overlay code, and it never causes HIDDEN_ATTR to be set.
  const DEBOUNCE_MS = 500;
  // ytd-rich-item-renderer: homepage grid card wrapper.
  // yt-lockup-view-model: the watch-page sidebar's related-video card — same
  // component the homepage wrapper contains internally, but on the sidebar it
  // appears bare (no ytd-rich-item-renderer wrapper). Confirmed live: the
  // sidebar's Shorts shelf uses an unrelated `ytm-shorts-lockup-view-model`
  // tag, so it's naturally excluded here. It also matches a search page's
  // promoted-video ad (`ytd-search-pyv-renderer` > ... > `yt-lockup-view-model`,
  // confirmed live), which isn't wrapped in any CARD_SELECTOR ancestor — same
  // as an in-feed ad on the homepage, which is wrapped in a real
  // ytd-rich-item-renderer and so is already scanned like any other card.
  // Consistent with that existing precedent, ads are not special-cased here.
  // ytd-video-renderer: search results page card wrapper.
  const CARD_SELECTOR = "ytd-rich-item-renderer, yt-lockup-view-model, ytd-video-renderer";
  const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

  let pendingIds = new Map(); // videoId -> card element, awaiting the next debounced flush
  let debounceTimer = null;
  let firstPendingAt = 0;
  const MAX_FLUSH_DELAY_MS = 1500; // cap so continuous scrolling can't defer a flush forever
  const MAX_BATCH = 50; // matches the Data API's per-call ID limit
  let filterEnabled = true;
  let hideMode = "remove"; // "remove" | "overlay" — set from GET_STATUS, kept live via storage.onChanged below
  let channelBadgeEnabled = true; // community-blocklist badge on/off — set from GET_STATUS/GET_CHANNEL_LISTS, kept live via storage.onChanged below
  let communityBlocklist = new Set(); // normalized handles/channel IDs — see background.js's AiSList section
  let communityWarnlist = new Set();

  // videoId -> WeakRef(card element), kept so a late (pushed) Pass 2 result can
  // find its card seconds after the original CHECK_VIDEOS. WeakRef, not the
  // element itself: YouTube drops feed cards for good as the page grows, and a
  // strong Map would pin every one of their subtrees for the life of the page.
  // A WeakRef pins nothing — the entry survives exactly as long as something
  // else (the document, or YouTube's own renderer holding a card it detached
  // and intends to re-attach) still references the element.
  const cardsById = new Map();

  // Cleans up a dead entry when its card is GC'd — but only if that entry is
  // still the one registered for this videoId (it may already have been
  // overwritten by a newer card for the same id, which must NOT be deleted).
  // A FinalizationRegistry callback, not a periodic sweep: an earlier version
  // walked the entire cardsById map every PRUNE_INTERVAL_CARDS newly-scanned
  // cards, which sounds amortized but isn't — the map only grows over a
  // session (entries are removed solely by GC, which is rare while a card is
  // still reachable), so each sweep costs O(current map size) and the sweeps
  // keep coming. Summed over a long scroll session that's O(N²) in total
  // cards seen, and was the actual cause of the reported "gets slower the
  // longer you scroll" behavior. Per-card GC callbacks cost O(1) each.
  const cardFinalizationRegistry = new FinalizationRegistry((videoId) => {
    const ref = cardsById.get(videoId);
    if (ref && !ref.deref()) cardsById.delete(videoId);
  });

  function log(...args) {
    console.log("[YouTube AI Filter]", ...args);
  }

  // videoId -> method, for cards hidden in "remove" hide mode. These cards
  // are still in the DOM (hidden by the .ytaif-removed class), so they can
  // equally be listed via data-ytaif-hidden like overlaid ones; this map is
  // kept because CLAUDE.md documents window.__ytaifRemoved as the way to
  // list them, and because it records the detection method compactly.
  const removedVideos = new Map();
  window.__ytaifRemoved = removedVideos;

  // Thumbnail container selectors, newest layout first — only used in
  // "overlay" hide mode. YouTube's homepage cards currently render as
  // `yt-lockup-view-model` (a `yt-thumbnail-view-model` wraps the thumbnail
  // image and is already `position: relative` with `overflow: hidden` and a
  // rounded corner — confirmed live, so an absolutely-positioned child clips
  // to the same rounded thumbnail bounds for free). `ytd-thumbnail` is the
  // search results page's own thumbnail wrapper (`ytd-video-renderer`'s
  // child) — confirmed live already `position: relative`, box bounds
  // matching the `<img>` exactly — and is also kept as a fallback for
  // older/other layouts.
  const THUMBNAIL_CONTAINER_SELECTOR = "yt-thumbnail-view-model, ytd-thumbnail";
  const METADATA_CONTAINER_SELECTOR = ".ytLockupViewModelMetadata, #details, #meta";

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

  // Channel link selector deliberately keyed on the href path prefix rather
  // than a specific component tag (unlike CARD_SELECTOR/THUMBNAIL_CONTAINER_SELECTOR):
  // the watch/title anchors always point to "/watch?v=...", so any "/@handle"
  // or "/channel/UC..." link inside a card is unambiguously the channel link
  // regardless of which wrapper component the current layout uses around it.
  // Confirmed live (homepage ytd-rich-item-renderer, search ytd-video-renderer):
  // both wrap the "vertical" yt-lockup-view-model variant, which includes a
  // real "/@handle" anchor around the channel name.
  // Confirmed live gap: the watch-page sidebar's bare yt-lockup-view-model
  // uses the "horizontal"/"Compact" variant instead (ytLockupViewModelHorizontal
  // ytLockupViewModelCompact), which renders the channel name as plain text
  // with NO anchor at all — not a selector bug, the link genuinely isn't in
  // the DOM there. extractChannelIdentifier returns null in that case;
  // extractChannelIdentifierFromData (below) is the sidebar fallback.
  const CHANNEL_LINK_SELECTOR = 'a[href^="/@"], a[href^="/channel/"]';

  // Normalizes to the same format AiSList entries are parsed into
  // (background.js's parseAisListText): handles lowercased (YouTube handles
  // are case-insensitive), channel IDs left exactly as they appear in the
  // href (they're case-sensitive, unlike handles).
  function extractChannelIdentifier(card) {
    const anchor = card.querySelector(CHANNEL_LINK_SELECTOR);
    if (!anchor) return null;
    const href = anchor.getAttribute("href") || "";
    const handleMatch = href.match(/^\/(@[\w.-]+)/);
    if (handleMatch) return handleMatch[1].toLowerCase();
    const channelIdMatch = href.match(/^\/channel\/(UC[\w-]+)/);
    if (channelIdMatch) return channelIdMatch[1];
    return null;
  }

  // Fallback for the sidebar gap CHANNEL_LINK_SELECTOR's comment describes.
  // The data that would answer this (the compact card's Polymer ancestor's
  // `.data.contents[]`) does exist, but NOT here: content.js runs in the
  // default isolated world, and that `.data` property is a plain JS expando
  // set by YouTube's own main-world Polymer code. Isolated worlds share the
  // DOM (real attributes, structure, layout) with the page, but each world
  // gets its own wrapper object per DOM node, so an expando another world's
  // script set on a node is invisible here — confirmed by hand: reading
  // `.data` from this world on a node whose `.data` a main-world script
  // reads fine returns undefined, every time, regardless of timing (an
  // earlier version of this fix mistakenly assumed a detach/re-attach race
  // and deferred this check to IntersectionObserver — that was never the
  // actual problem and didn't fix anything, though it's harmless to keep).
  // channel-data-relay.js is a SEPARATE content script declared with
  // "world": "MAIN" in manifest.json specifically to cross this boundary: it
  // reads `.data` where it's visible and republishes the result as a real
  // DOM attribute (BRIDGE_ATTR below), which — being a real attribute, not
  // an expando — IS visible from this world. This function just reads that
  // attribute; all the actual `.data.contents[]` traversal lives in
  // channel-data-relay.js now.
  const CHANNEL_BRIDGE_ATTR = "data-ytaif-channel-bridge";

  function extractChannelIdentifierFromBridge(card) {
    return card.getAttribute(CHANNEL_BRIDGE_ATTR);
  }

  // --- Community channel-blocklist signal (AiSList) ---------------------
  // Deliberately weaker than Pass 1/2, both of which only ever relay
  // YouTube's OWN stated verdict. This is a third-party crowd-sourced list
  // that can go stale (see background.js's comment on this). So unlike
  // hideCard, this NEVER removes/overlays a card — it only ever adds a
  // small, non-blocking corner badge, and the video stays fully visible and
  // clickable. Do not route this through hideCard/applyRemovedStyle/overlay
  // code, and do not set HIDDEN_ATTR from here.
  function buildCommunityBadge(confidence) {
    const badge = document.createElement("span");
    badge.className =
      confidence === "blocklist" ? "ytaif-community-badge" : "ytaif-community-badge ytaif-community-badge-warn";
    badge.textContent = confidence === "blocklist" ? "Possibly AI (community-flagged)" : "Possibly AI (community-suspected)";
    badge.title =
      "Flagged by AiSList, a community-maintained channel list — not a YouTube-confirmed label, and it can be stale. This never hides the video.";
    return badge;
  }

  function applyChannelBadge(card, confidence) {
    const anchorPoint = card.querySelector(THUMBNAIL_CONTAINER_SELECTOR);
    if (!anchorPoint) return; // no positioning context to anchor into — skip rather than misplace it
    anchorPoint.classList.add("ytaif-thumb-container");
    anchorPoint.appendChild(buildCommunityBadge(confidence));
    card.setAttribute(CHANNEL_BADGE_ATTR, confidence);
  }

  function removeChannelBadge(card) {
    const badge = card.querySelector(".ytaif-community-badge");
    if (badge) badge.remove();
    card.removeAttribute(CHANNEL_BADGE_ATTR);
  }

  // Cheap, O(1) check for a single newly-scanned card — used inline in
  // scanForCards so a fresh card gets its badge immediately without waiting
  // for a full reconcile pass.
  function maybeApplyChannelBadge(card, channelId) {
    if (!channelBadgeEnabled || !channelId) return;
    if (communityBlocklist.has(channelId)) {
      applyChannelBadge(card, "blocklist");
    } else if (communityWarnlist.has(channelId)) {
      applyChannelBadge(card, "warnlist");
    }
  }

  // Full sweep, deliberately reserved for rare events only (initial list
  // load, a ~12h list refresh, or the user flipping the badge toggle) — never
  // called per scan batch. Re-running this on every newly-scanned card would
  // reintroduce exactly the O(N²)-over-a-long-scroll-session bug described
  // for cardsById's old pruning sweep above.
  function reconcileChannelBadges() {
    for (const card of document.querySelectorAll(`[${CHANNEL_ATTR}]`)) {
      const channelId = card.getAttribute(CHANNEL_ATTR);
      const currentFlag = card.getAttribute(CHANNEL_BADGE_ATTR);
      let desiredFlag = null;
      if (channelBadgeEnabled) {
        if (communityBlocklist.has(channelId)) desiredFlag = "blocklist";
        else if (communityWarnlist.has(channelId)) desiredFlag = "warnlist";
      }
      if (desiredFlag === currentFlag) continue;
      if (currentFlag) removeChannelBadge(card);
      if (desiredFlag) applyChannelBadge(card, desiredFlag);
    }
  }

  function hideCard(card, videoId, method) {
    if (hideMode === "overlay") {
      hideCardWithOverlay(card, videoId, method);
    } else {
      hideCardByRemoval(card, videoId, method);
    }
  }

  // Every element that currently stands for this video, from both directions.
  // Both halves are load-bearing:
  //
  //  - The DOM query is the authority on what is on the page *now*. It finds a
  //    card whose Map entry is gone (WeakRef collected, element since
  //    re-created by YouTube), and it finds the same video on more than one
  //    card, which a videoId -> single-card Map cannot represent at all.
  //  - The Map entry covers the opposite case, and is the one the old code
  //    lost: ytd-rich-grid-renderer detaches and re-attaches feed cards during
  //    streaming and re-layout, so at the instant a late Pass 2 verdict arrives
  //    the card can be detached — invisible to querySelector — while still
  //    perfectly alive and about to be put back.
  //
  // Hiding a detached card is safe and sticks, because both presentations are
  // class/attribute changes on the card's own subtree and survive a re-attach.
  // That is the same property that made "remove" mode use a class instead of
  // card.remove() (see applyRemovedStyle).
  function resolveCardsForVideoId(videoId, knownCard) {
    const cards = new Set();
    if (knownCard) cards.add(knownCard);

    const remembered = cardsById.get(videoId);
    const rememberedCard = remembered && remembered.deref();
    if (rememberedCard) cards.add(rememberedCard);
    else if (remembered) cardsById.delete(videoId);

    // videoId arrives back from background.js here; it originated from
    // extractVideoId, but re-validate before interpolating it into a selector.
    if (VIDEO_ID_RE.test(videoId)) {
      for (const el of document.querySelectorAll(`[${VIDEO_ID_ATTR}="${videoId}"]`)) cards.add(el);
    }
    return cards;
  }

  function hideVideo(videoId, method, knownCard) {
    const cards = resolveCardsForVideoId(videoId, knownCard);
    if (cards.size === 0) {
      // The video really is off the page (feed re-render, SPA navigation).
      log(`No card on the page for ${videoId} — verdict (${method}) dropped.`);
      return;
    }
    for (const card of cards) hideCard(card, videoId, method);
  }

  // Applies the "removed" presentation. Note what this deliberately does NOT
  // do: call card.remove(). Detaching the element was the original approach
  // and it failed in two ways that "overlay" mode never hit, which is why
  // remove mode looked broken while labelling worked:
  //   1. It bailed out on `!card.isConnected`. YouTube detaches and re-attaches
  //      feed cards while the page is still streaming/re-laying-out, so a card
  //      that was detached at the moment its verdict arrived was silently never
  //      hidden — and never retried, since it already carries PROCESSED_ATTR.
  //   2. ytd-rich-grid-renderer still owns the card and can re-stamp an item
  //      it did not expect to disappear.
  // A class has neither problem: it survives a detach/re-attach cycle, and it
  // does not fight the renderer. This also makes the presentation reversible,
  // so disabling the filter and switching hide modes now work in both
  // directions instead of only overlay -> remove.
  function applyRemovedStyle(card) {
    card.classList.add("ytaif-removed");
    card.setAttribute(HIDE_STYLE_ATTR, "removed");
  }

  function hideCardByRemoval(card, videoId, method) {
    if (card.getAttribute(HIDDEN_ATTR) === "true") return;

    card.setAttribute(HIDDEN_ATTR, "true");
    card.setAttribute(HIDDEN_METHOD_ATTR, method);
    applyRemovedStyle(card);
    removedVideos.set(videoId, method);

    log(`Removed AI-labeled video: ${videoId} (via ${method})`);
    chrome.runtime.sendMessage({ type: "INCREMENT_HIDDEN_COUNT", method }).catch(() => {});
  }

  // BUG B FIX: never remove or replace the card's own DOM subtree — YouTube's
  // grid sizing depends on the card's original layout, and swapping it for a
  // plain div broke row alignment. Instead, the original thumbnail/title/
  // metadata elements stay exactly as they are; we only overlay the
  // thumbnail area and visually hide (not remove) the text underneath.
  function buildOverlay(videoId, method) {
    const overlay = document.createElement("div");
    overlay.className = "ytaif-overlay";
    overlay.setAttribute("role", "button");
    overlay.setAttribute("tabindex", "0");

    const icon = document.createElement("span");
    icon.className = "ytaif-overlay-icon";
    icon.textContent = "AI";
    icon.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "ytaif-overlay-text";
    text.textContent =
      method === "watch-page" ? "AI-labeled (auto-detect) — click to show" : "AI-labeled — click to show";

    overlay.appendChild(icon);
    overlay.appendChild(text);
    return overlay;
  }

  // Returns true if the overlay presentation could be applied. Split out from
  // hideCardWithOverlay so a live "remove" -> "overlay" mode switch can apply
  // it to a card that is already hidden, without re-counting it as a new hide.
  function applyOverlayStyle(card, videoId, method) {
    const thumbnailContainer = card.querySelector(THUMBNAIL_CONTAINER_SELECTOR);
    if (!thumbnailContainer) {
      log(`Could not find thumbnail container for ${videoId} — skipping hide to avoid breaking layout.`);
      return false;
    }

    // Force a positioning context in case a future layout variant doesn't
    // already have one — safe no-op when it already does (confirmed live).
    thumbnailContainer.classList.add("ytaif-thumb-container");

    const overlay = buildOverlay(videoId, method);
    thumbnailContainer.appendChild(overlay);

    const metadataContainer = card.querySelector(METADATA_CONTAINER_SELECTOR);
    if (metadataContainer) {
      metadataContainer.classList.add("ytaif-metadata-hidden");
    }

    card.setAttribute(HIDE_STYLE_ATTR, "overlay");

    const reveal = () => {
      clearHideStyles(card);
      card.removeAttribute(HIDDEN_ATTR);
      card.removeAttribute(HIDDEN_METHOD_ATTR);
      removedVideos.delete(videoId);
    };

    overlay.addEventListener("click", (e) => {
      // The overlay's thumbnail container sits inside the card's own <a
      // href="/watch?v=..."> anchor in some layouts — without these, a click
      // to reveal the card would also navigate to the video.
      e.preventDefault();
      e.stopPropagation();
      reveal();
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        reveal();
      }
    });

    return true;
  }

  function hideCardWithOverlay(card, videoId, method) {
    if (card.getAttribute(HIDDEN_ATTR) === "true") return;
    if (!applyOverlayStyle(card, videoId, method)) return;

    card.setAttribute(HIDDEN_ATTR, "true");
    card.setAttribute(HIDDEN_METHOD_ATTR, method);

    log(`Hid AI-labeled video: ${videoId} (via ${method})`);
    chrome.runtime.sendMessage({ type: "INCREMENT_HIDDEN_COUNT", method }).catch(() => {});
  }

  // Strips whichever presentation is currently applied, leaving the card
  // visible and untouched. Safe to call for either hide mode.
  function clearHideStyles(card) {
    card.classList.remove("ytaif-removed");
    const overlay = card.querySelector(".ytaif-overlay");
    if (overlay) overlay.remove();
    const thumbnailContainer = card.querySelector(THUMBNAIL_CONTAINER_SELECTOR);
    if (thumbnailContainer) thumbnailContainer.classList.remove("ytaif-thumb-container");
    const metadataContainer = card.querySelector(METADATA_CONTAINER_SELECTOR);
    if (metadataContainer) metadataContainer.classList.remove("ytaif-metadata-hidden");
    card.removeAttribute(HIDE_STYLE_ATTR);
  }

  function unhideCard(card) {
    if (card.getAttribute(HIDDEN_ATTR) !== "true") return;
    clearHideStyles(card);
    const videoId = card.getAttribute(VIDEO_ID_ATTR);
    if (videoId) removedVideos.delete(videoId);
    card.removeAttribute(HIDDEN_ATTR);
    card.removeAttribute(HIDDEN_METHOD_ATTR);
  }

  function showConfigureBanner() {
    if (document.querySelector(".ytaif-banner")) return;
    const banner = document.createElement("div");
    banner.className = "ytaif-banner";
    banner.textContent =
      "YouTube AI Filter: no API key configured. Click the extension icon to add one.";
    document.body.prepend(banner);
  }

  function showQuotaBanner(until) {
    if (document.querySelector(".ytaif-banner")) return;
    const resetTime = until ? new Date(until).toLocaleString() : "later today";
    const banner = document.createElement("div");
    banner.className = "ytaif-banner ytaif-banner-quota";
    banner.textContent = `YouTube AI Filter: daily API quota exhausted. Resets ${resetTime}.`;
    document.body.prepend(banner);
  }

  function flushPending() {
    firstPendingAt = 0;
    if (pendingIds.size === 0) return;
    const idToCard = new Map(pendingIds);
    pendingIds = new Map();

    const videoIds = Array.from(idToCard.keys());
    chrome.runtime
      .sendMessage({ type: "CHECK_VIDEOS", videoIds })
      .then((response) => {
        if (!response) return;

        if (response.error === "noApiKey") {
          showConfigureBanner();
        } else if (response.error === "quotaExceeded") {
          showQuotaBanner(response.quotaExhaustedUntil);
        }

        if (!filterEnabled) return;

        const syntheticIds = new Set(response.synthetic || []);
        for (const [id, card] of idToCard.entries()) {
          if (syntheticIds.has(id)) {
            // Pass the card we queued as a hint, but resolve the rest the same
            // way a late result does: it may have been detached and re-attached
            // while the request was in flight, and idToCard (keyed by videoId)
            // only holds one card for a video the feed happened to show twice.
            hideVideo(id, "api", card);
          }
        }
        // response.pending: IDs the API didn't flag, now queued in
        // background.js for the watch-page fallback. Results for those
        // arrive later via the SYNTHETIC_RESULT push message below.
      })
      .catch((err) => {
        log("Error checking videos:", err);
      });
  }

  function scheduleFlush() {
    if (!firstPendingAt) firstPendingAt = Date.now();
    if (debounceTimer) clearTimeout(debounceTimer);
    // During continuous scrolling, intersections keep arriving and would
    // otherwise reset this timer forever — flush is deferred until scrolling
    // stops, building one huge batch that then floods the Pass 2 queue. Force
    // a flush once a batch gets big or has waited long enough regardless.
    if (pendingIds.size >= MAX_BATCH || Date.now() - firstPendingAt >= MAX_FLUSH_DELAY_MS) {
      debounceTimer = null;
      flushPending();
      return;
    }
    debounceTimer = setTimeout(flushPending, DEBOUNCE_MS);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "SYNTHETIC_RESULT" && message.synthetic !== false) {
      if (filterEnabled) {
        hideVideo(message.videoId, message.method || "watch-page");
      }
    }
  });

  // channel-data-relay.js (main world) dispatches this on window — a plain
  // DOM CustomEvent, not chrome.runtime messaging, since the main world has
  // no access to chrome.* APIs at all. Covers the race where a card becomes
  // visible (and gets its one IntersectionObserver-triggered channel check)
  // before the bridge attribute for it has been written yet: this retries
  // once the attribute actually lands. resolveCardsForVideoId, not a plain
  // lookup, for the same reasons documented on it above.
  window.addEventListener("ytaif-channel-bridge-update", (event) => {
    const videoId = event.detail?.videoId;
    if (!videoId) return;
    for (const card of resolveCardsForVideoId(videoId)) {
      if (card.hasAttribute(CHANNEL_ATTR)) continue;
      const channelId = extractChannelIdentifierFromBridge(card);
      if (channelId) {
        card.setAttribute(CHANNEL_ATTR, channelId);
        maybeApplyChannelBadge(card, channelId);
      }
    }
  });

  // --- IntersectionObserver: only queue cards once they're actually visible ---

  const intersectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const card = entry.target;
        intersectionObserver.unobserve(card);

        const videoId = card.getAttribute(VIDEO_ID_ATTR);
        if (!videoId) continue;
        pendingIds.set(videoId, card);
        scheduleFlush();

        // The bridge attribute (channel-data-relay.js, main world) may not
        // have been written yet for a card that only just became visible —
        // that race is handled by the ytaif-channel-bridge-update listener
        // below, which retries once it arrives.
        const channelId = extractChannelIdentifier(card) || extractChannelIdentifierFromBridge(card);
        if (channelId) {
          card.setAttribute(CHANNEL_ATTR, channelId);
          maybeApplyChannelBadge(card, channelId);
        }
      }
    },
    { root: null, rootMargin: "200px 0px", threshold: 0.01 }
  );

  function scanForCards(root) {
    // Scan the given root itself if it's a card, plus any card descendants —
    // never a wider ancestor. The mutation-observer callback below used to
    // pass `node.parentElement` (or document.body) here, which re-querySelectorAll'd
    // every card loaded so far on every single card added by infinite scroll:
    // quadratic cost across a long scroll session.
    const cards = [];
    if (root.matches && root.matches(CARD_SELECTOR)) cards.push(root);
    if (root.querySelectorAll) cards.push(...root.querySelectorAll(CARD_SELECTOR));

    for (const card of cards) {
      if (card.getAttribute(PROCESSED_ATTR) === "true") continue;
      // CARD_SELECTOR matches multiple tags where one could, in principle,
      // nest another (a homepage yt-lockup-view-model living inside its
      // ytd-rich-item-renderer wrapper). If that ever happens, only the
      // outer element is the real card — skip a match that's inside another
      // match, so the same physical card is never processed twice.
      if (card.parentElement && card.parentElement.closest(CARD_SELECTOR)) continue;
      const videoId = extractVideoId(card);
      if (!videoId) continue;

      card.setAttribute(PROCESSED_ATTR, "true");
      card.setAttribute(VIDEO_ID_ATTR, videoId);
      cardsById.set(videoId, new WeakRef(card));
      cardFinalizationRegistry.register(card, videoId);
      intersectionObserver.observe(card);
      // Channel/community-badge extraction happens later, in the
      // IntersectionObserver callback below — see the comment there.
    }
  }

  // Resolve the container by page type FIRST, never by a global
  // querySelector race. Confirmed live: ytd-watch-next-secondary-results-renderer
  // is part of YouTube's persistent ytd-app shell and is present in the DOM on
  // *every* page type, not just watch pages. The previous ordered-fallback
  // chain therefore resolved it on a search results page — before
  // ytd-section-list-renderer was ever tried — and bound the mutation observer
  // to an unrelated empty container that never receives search cards, so
  // search results were never scanned at all (verified: that element does not
  // contain the ytd-video-renderer cards; ytd-section-list-renderer does).
  //
  // document.body remains the fallback when a page's own container hasn't
  // been created yet: broader than necessary, but correct.
  function findFeedContainer() {
    const path = location.pathname;

    if (path === "/" || path.startsWith("/feed")) {
      return document.querySelector("ytd-rich-grid-renderer") || document.body;
    }
    if (path === "/results") {
      // Wraps every result section (videos, channels, the Shorts shelf, ads).
      return document.querySelector("ytd-section-list-renderer") || document.body;
    }
    if (path === "/watch") {
      // Sidebar: wraps both the related-videos list and the Shorts shelf.
      return document.querySelector("ytd-watch-next-secondary-results-renderer") || document.body;
    }
    return document.body;
  }

  let boundContainer = null;
  let mutationObserver = null;

  // Binds (or re-binds) the mutation observer to whatever findFeedContainer()
  // currently resolves to, and scans it immediately. Called once at startup
  // and again on every SPA navigation — see the yt-navigate-finish listener
  // below for why re-deriving the container is necessary, not optional.
  function bindFeedObserver() {
    const container = findFeedContainer();
    // Same element as last time (e.g. both resolved to the document.body
    // fallback because the page's own container hadn't been created yet) —
    // the existing observer already watches this whole subtree, so there's
    // nothing to rebind. Just pick up anything new.
    if (container === boundContainer) {
      scanForCards(container);
      return;
    }

    if (mutationObserver) mutationObserver.disconnect();
    boundContainer = container;
    scanForCards(container);

    let scanScheduled = false;
    const pendingScanRoots = new Set();

    function scheduleScan(root) {
      pendingScanRoots.add(root);
      if (scanScheduled) return;
      scanScheduled = true;
      requestAnimationFrame(() => {
        scanScheduled = false;
        const roots = Array.from(pendingScanRoots);
        pendingScanRoots.clear();
        for (const r of roots) scanForCards(r);
      });
    }

    mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if ((node.matches && node.matches(CARD_SELECTOR)) || node.querySelector?.(CARD_SELECTOR)) {
            scheduleScan(node);
          }
        }
      }
    });

    mutationObserver.observe(container, { childList: true, subtree: true });
    log("Observing feed for new videos (lazy, viewport-triggered checks).");
  }

  // YouTube is a SPA: clicking the logo, a video, a search result, etc. swaps
  // the page's content client-side without a full reload, so content.js's
  // one-time document_idle init never runs again and the mutation observer
  // stays bound to whatever container the PREVIOUS page used — which YouTube
  // may detach entirely (e.g. the watch page's sidebar container isn't part
  // of the homepage). New cards on the new page then land in a container the
  // observer was never watching and are silently never scanned. Confirmed
  // live: clicking the YouTube logo while watching a video reproduces this —
  // the homepage that loads afterward never gets filtered.
  // `yt-navigate-finish` fires on `document` after every SPA navigation
  // completes, by which point the new page's containers already exist (same
  // timing the initial document_idle bind relies on) — re-deriving the
  // container and rebinding here closes the gap.
  document.addEventListener("yt-navigate-finish", bindFeedObserver);

  function startObserving() {
    bindFeedObserver();
  }

  // Turning the filter off now restores every currently-hidden card in BOTH
  // hide modes — "remove" mode no longer detaches the element, so there is
  // something left to restore. Previously this only worked under "overlay".
  function applyFilterEnabledState(enabled) {
    filterEnabled = enabled;
    if (!enabled) {
      const hiddenCards = document.querySelectorAll(`[${HIDDEN_ATTR}="true"]`);
      for (const card of hiddenCards) unhideCard(card);
    }
  }

  // Re-presents every currently-hidden card in the newly-selected hide mode,
  // without a page reload. This now works in BOTH directions: neither mode
  // detaches the card, so a "remove"-hidden card is still in the DOM (and
  // still in its original grid position) and can be given an overlay instead,
  // which the old card.remove() approach made impossible. A card the user
  // already clicked to reveal is untouched, since it no longer carries
  // HIDDEN_ATTR.
  function convertHiddenCardsToMode(newMode) {
    const hiddenCards = document.querySelectorAll(`[${HIDDEN_ATTR}="true"]`);
    for (const card of hiddenCards) {
      if (card.getAttribute(HIDE_STYLE_ATTR) === newMode) continue;
      const videoId = card.getAttribute(VIDEO_ID_ATTR);
      const method = card.getAttribute(HIDDEN_METHOD_ATTR) || "api";
      if (!videoId) continue;

      // Not hideCard*: this is a mode conversion of an already-hidden card,
      // not a new hide, so it must not re-increment the session counter.
      clearHideStyles(card);
      if (newMode === "overlay") {
        if (applyOverlayStyle(card, videoId, method)) {
          removedVideos.delete(videoId);
        } else {
          // No thumbnail container to overlay — keep it hidden rather than
          // silently revealing an AI-labeled video on a mode change.
          applyRemovedStyle(card);
        }
      } else {
        applyRemovedStyle(card);
        removedVideos.set(videoId, method);
      }
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.ytaif_filterEnabled) {
      applyFilterEnabledState(changes.ytaif_filterEnabled.newValue !== false);
    }
    if (changes.ytaif_hideMode) {
      const newMode = changes.ytaif_hideMode.newValue || "remove";
      const oldMode = hideMode;
      hideMode = newMode;
      if (oldMode !== newMode) {
        convertHiddenCardsToMode(newMode);
      }
    }
    if (changes.ytaif_channelBadgeEnabled) {
      channelBadgeEnabled = changes.ytaif_channelBadgeEnabled.newValue !== false;
      reconcileChannelBadges();
    }
    if (changes.ytaif_channelLists) {
      const newVal = changes.ytaif_channelLists.newValue || { blocklist: [], warnlist: [] };
      communityBlocklist = new Set(newVal.blocklist || []);
      communityWarnlist = new Set(newVal.warnlist || []);
      reconcileChannelBadges();
    }
  });

  function init() {
    chrome.runtime
      .sendMessage({ type: "GET_STATUS" })
      .then((status) => {
        if (!status) return;
        filterEnabled = status.filterEnabled;
        hideMode = status.hideMode || "remove";
        channelBadgeEnabled = status.channelBadgeEnabled !== false;
        if (!status.hasApiKey) showConfigureBanner();
        else if (status.quotaExhaustedUntil) showQuotaBanner(status.quotaExhaustedUntil);
      })
      .catch(() => {});

    // Fetched separately from GET_STATUS since these lists (unlike settings)
    // can be tens of thousands of entries — background.js owns the fetch,
    // this just pulls the parsed result once and does local Set lookups from
    // then on, no per-card round trip.
    chrome.runtime
      .sendMessage({ type: "GET_CHANNEL_LISTS" })
      .then((response) => {
        if (!response) return;
        communityBlocklist = new Set(response.blocklist || []);
        communityWarnlist = new Set(response.warnlist || []);
        if (typeof response.channelBadgeEnabled === "boolean") {
          channelBadgeEnabled = response.channelBadgeEnabled;
        }
        reconcileChannelBadges(); // catches up any card scanned before this resolved
      })
      .catch(() => {});

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startObserving);
    } else {
      startObserving();
    }
  }

  init();
})();
