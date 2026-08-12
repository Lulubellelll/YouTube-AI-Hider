const API_KEY_STORAGE_KEY = "ytaif_apiKey";
const FILTER_ENABLED_KEY = "ytaif_filterEnabled";
const SCAN_INTENSITY_KEY = "ytaif_scanIntensity";
const HIDE_MODE_KEY = "ytaif_hideMode";
const PASS1_ENABLED_KEY = "ytaif_pass1Enabled";
const CHANNEL_BADGE_ENABLED_KEY = "ytaif_channelBadgeEnabled";
const SESSION_API_COUNT_KEY = "ytaif_sessionApiHiddenCount";
const SESSION_SCAN_COUNT_KEY = "ytaif_sessionScanHiddenCount";

const filterToggle = document.getElementById("filterToggle");
const pass1Toggle = document.getElementById("pass1Toggle");
const scanIntensityGroup = document.getElementById("scanIntensityGroup");
const channelBadgeToggle = document.getElementById("channelBadgeToggle");
const channelListMeta = document.getElementById("channelListMeta");
const hideModeGroup = document.getElementById("hideModeGroup");
const totalCountEl = document.getElementById("totalCount");
const apiCountEl = document.getElementById("apiCount");
const scanCountEl = document.getElementById("scanCount");
const statusBanner = document.getElementById("statusBanner");
const statusText = document.getElementById("statusText");
const apiKeyInput = document.getElementById("apiKeyInput");
const saveKeyButton = document.getElementById("saveKeyButton");
const keyStatus = document.getElementById("keyStatus");
const versionTag = document.getElementById("versionTag");

function setBanner(text, kind) {
  statusText.textContent = text;
  statusBanner.className = `status ${kind}`;
  statusBanner.hidden = false;
}

function setSegmentedValue(groupEl, value) {
  groupEl.querySelectorAll("[data-value]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.dataset.value === value));
  });
}

function formatChannelListMeta(status) {
  if (!status?.channelListFetchedAt) return "Not fetched yet.";
  const total = (status.channelListCounts?.blocklist || 0) + (status.channelListCounts?.warnlist || 0);
  const updated = new Date(status.channelListFetchedAt).toLocaleDateString();
  return `${total.toLocaleString()} channels, updated ${updated}.`;
}

async function refreshStatus() {
  const local = await chrome.storage.local.get([
    API_KEY_STORAGE_KEY,
    FILTER_ENABLED_KEY,
    SCAN_INTENSITY_KEY,
    HIDE_MODE_KEY,
    PASS1_ENABLED_KEY,
    CHANNEL_BADGE_ENABLED_KEY,
  ]);
  const hasApiKey = Boolean(local[API_KEY_STORAGE_KEY]);
  const filterEnabled = local[FILTER_ENABLED_KEY] !== false;
  const scanIntensity = local[SCAN_INTENSITY_KEY] || "normal";
  const hideMode = local[HIDE_MODE_KEY] || "remove";
  const pass1Enabled = local[PASS1_ENABLED_KEY] !== false;
  const channelBadgeEnabled = local[CHANNEL_BADGE_ENABLED_KEY] !== false;

  filterToggle.checked = filterEnabled;
  pass1Toggle.checked = pass1Enabled;
  setSegmentedValue(scanIntensityGroup, scanIntensity);
  channelBadgeToggle.checked = channelBadgeEnabled;
  setSegmentedValue(hideModeGroup, hideMode);

  keyStatus.textContent = hasApiKey ? "Saved" : "Not set";
  keyStatus.classList.toggle("saved", hasApiKey);
  if (hasApiKey) {
    apiKeyInput.placeholder = "•••••••••••••••••••• (saved)";
  }

  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  channelListMeta.textContent = formatChannelListMeta(status);

  if (!pass1Enabled && scanIntensity === "off") {
    setBanner("Both Pass 1 and Pass 2 are off — only the community badge (if enabled) is active.", "warning");
  } else if (!hasApiKey && scanIntensity === "off") {
    setBanner("No API key configured and Pass 2 is off — filter is inactive.", "error");
  } else if (!hasApiKey) {
    setBanner("No API key configured. Pass 2 is still active, but self-disclosed videos won't be caught until you add one.", "warning");
  } else if (status?.quotaExhaustedUntil) {
    const resetTime = new Date(status.quotaExhaustedUntil).toLocaleString();
    setBanner(`Daily API quota exhausted. Resets ${resetTime}. Pass 2 still runs if enabled.`, "error");
  } else {
    setBanner("Filter active.", "ok");
  }
}

async function refreshSessionCounts() {
  const result = await chrome.storage.session.get([
    SESSION_API_COUNT_KEY,
    SESSION_SCAN_COUNT_KEY,
  ]);
  const apiCount = result[SESSION_API_COUNT_KEY] || 0;
  const scanCount = result[SESSION_SCAN_COUNT_KEY] || 0;
  apiCountEl.textContent = String(apiCount);
  scanCountEl.textContent = String(scanCount);
  totalCountEl.textContent = String(apiCount + scanCount);
}

filterToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ [FILTER_ENABLED_KEY]: filterToggle.checked });
});

pass1Toggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ [PASS1_ENABLED_KEY]: pass1Toggle.checked });
  await refreshStatus();
});

channelBadgeToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ [CHANNEL_BADGE_ENABLED_KEY]: channelBadgeToggle.checked });
});

scanIntensityGroup.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-value]");
  if (!btn) return;
  setSegmentedValue(scanIntensityGroup, btn.dataset.value);
  await chrome.storage.local.set({ [SCAN_INTENSITY_KEY]: btn.dataset.value });
  await refreshStatus();
});

hideModeGroup.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-value]");
  if (!btn) return;
  setSegmentedValue(hideModeGroup, btn.dataset.value);
  await chrome.storage.local.set({ [HIDE_MODE_KEY]: btn.dataset.value });
});

saveKeyButton.addEventListener("click", async () => {
  const value = apiKeyInput.value.trim();
  if (!value) return;
  await chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: value });
  apiKeyInput.value = "";
  await refreshStatus();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "session") {
    if (changes[SESSION_API_COUNT_KEY] || changes[SESSION_SCAN_COUNT_KEY]) {
      refreshSessionCounts();
    }
  }
  if (areaName === "local") {
    refreshStatus();
  }
});

versionTag.textContent = `v${chrome.runtime.getManifest().version}`;
refreshStatus();
refreshSessionCounts();
