# YouTube AI Filter

Hides YouTube videos that YouTube itself labels "Altered or synthetic content."

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4)
![No build step](https://img.shields.io/badge/build%20step-none-brightgreen)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

YouTube has labeled creator-disclosed AI content since 2024, and started
labeling it automatically in May 2026. Most AI filter extensions ignore all
that and run on crowd-sourced channel blocklists instead. This one uses
YouTube's own signal: the official Data API for creator disclosures, and the
label YouTube renders on the watch page for everything its detection catches
on its own. Community flagging is in here too, as an optional badge on top.

Works on the homepage feed, search results, and the watch page sidebar.

## Install

Not on the Chrome Web Store yet, so load it unpacked:

1. Clone or [download](../../archive/refs/heads/main.zip) this repo.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. **Load unpacked**, select this folder.

After pulling updates, hit refresh on the extension card, then reload your
YouTube tabs.

## Setup

Open the popup:

1. Turn on **Enable filter**.
2. Paste a YouTube Data API key if you want the creator-disclosure check.
   It's free and there's a "Show me how →" link in the popup. Everything
   else works without one.
3. Pick a hide mode: **Remove** (card disappears, grid closes up) or
   **Label** (card stays, covered by a click-to-show overlay).
4. Turn on community channel badges if you want them.

## How it works

Three signals, cheapest first.

**API check.** Video IDs get batched as cards scroll into view and sent to
`videos.list?part=status`. Roughly 1 quota unit per 50 videos. Catches
creator disclosures only.

**Watch-page check.** YouTube's automatic detection never reaches that API
field, so anything the API misses gets a background fetch of its watch page,
which is searched for the same disclosure panel YouTube shows on screen.
Rate limited to one request at a time and only for cards you actually
scrolled to. This one reads undocumented page structure, so expect it to
break whenever YouTube reshuffles its frontend. The API check is unaffected
when that happens.

**Community list.** Channels are checked against a local copy of
[AiSList](https://github.com/Override92/AiSList), refreshed every 12 hours.
Badge only. It never hides anything, because it's a crowd judgment rather
than YouTube's, and those go stale.

Results are cached locally for 7 days. No video is ever opened or played to
check it.

## Privacy

No analytics, no telemetry, nothing reported anywhere. Your API key and all
cached results stay in `chrome.storage.local` on your machine.

Three hosts get contacted and that's the entire list: `youtube.com` for the
watch-page check, `googleapis.com` for the API check, and
`raw.githubusercontent.com` for the community list. The watch-page fetch
carries your normal YouTube cookies, the same as any tab you already have
open, so it isn't anonymous. It asks for the page HTML and nothing else.

## Development

No build step. Edit a file, refresh the extension, reload a YouTube tab.

Read [`CLAUDE.md`](CLAUDE.md) before touching `content.js` or
`background.js`. It documents why several odd-looking things are written the
way they are, each of which took real debugging to land on.

When the watch-page check stops matching, this dumps the page structure so
you can find where the label moved:

```bash
node scripts/inspect-watch-page.js <video-id>
```

Issues and PRs welcome.

## Credits

Channel data from [AiSList](https://github.com/Override92/AiSList) by
Override92, CC BY-NC 4.0.

## License

MIT, see [LICENSE](LICENSE).
