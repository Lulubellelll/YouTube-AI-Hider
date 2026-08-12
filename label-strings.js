// Fallback text-matching config for the watch-page AI-label detector
// (background.js -> checkWatchPageForAILabel). Loaded into the background
// service worker via importScripts().
//
// PRIMARY signal (see background.js): the presence of a
// `howThisWasMadeSectionViewModel` node within the primary video's own data
// (never inside `secondaryResults`, the related-videos sidebar), whose own
// text specifically references the "Altered or synthetic content"
// support-article ID below — checked per-node, not across a whole branch.
//
// AI_DISCLOSURE_SUPPORT_ARTICLE_ID is the reliable signal. It is a URL
// segment, not translated text, so it's locale-independent, and it is
// specific to the "Altered or synthetic content" disclosure — unlike the
// `howThisWasMadeSectionViewModel` container itself, which YouTube also
// reuses for at least one unrelated disclosure (auto-dubbed audio tracks,
// support article 15569972, e.g. Turkish "Bazı diller için ses parçaları
// otomatik olarak oluşturuldu" — a benign accessibility feature that must
// NOT be hidden by this extension).
const AI_DISCLOSURE_SUPPORT_ARTICLE_ID = "15447836";

// AI_LABEL_PHRASES is a secondary, low-risk confirmation checked ONLY
// within the text of an already-located howThisWasMadeSectionViewModel
// node (never as a blind whole-page or whole-branch search) — see
// background.js's nodeIsSyntheticContentDisclosure().
//
// A Turkish phrase ("Yapay zeka") was previously listed here and has been
// REMOVED after live testing found it caused real false positives: it
// matched an entirely unrelated YouTube "AI answers" panel disclaimer
// ("Yapay zeka yanlış bilgi verebilir...") that has nothing to do with
// video content disclosure, and — separately — it isn't even the actual
// wording YouTube uses for this disclosure. The real Turkish text is
// "Sesler veya görseller değiştirildi ya da tamamen yapay şekilde
// oluşturuldu", confirmed against a known AI-labeled video's live page.
//
// Before adding a new locale phrase here: verify it against the actual
// `bodyText.content` of a real howThisWasMadeSectionViewModel node for
// that locale (see scripts/inspect-watch-page.js), not just "does this
// string appear somewhere on the page" — the ID above already makes this
// list optional, so a wrong or overly generic phrase does more harm
// (false positives) than a missing one (an extra fallback layer).
const AI_LABEL_PHRASES = ["Altered or synthetic content"]; // English, verified
