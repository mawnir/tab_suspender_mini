console.log("Tab Suspender extension loaded");

// Set true while debugging. Keep false by default: per-tab logging is what
// kills performance with hundreds/thousands of tabs (I/O + string building
// on every event/sweep).
const DEBUG = false;
const debug = (...args) => { if (DEBUG) console.log(...args); };

// ---- cross-browser compat (Firefox `browser` = promises, Chrome `chrome` = callbacks) ----
// `typeof` guard avoids ReferenceError when `browser` is undefined in Chrome.
const extApi = (typeof browser !== "undefined" && browser) || (typeof chrome !== "undefined" && chrome);
if (!extApi) throw new Error("No WebExtension API found (browser/chrome)");

function _promisify(fn, ...args) {
    try {
        const maybePromise = fn(...args);
        if (maybePromise && typeof maybePromise.then === "function") return maybePromise;
    } catch (e) {
        return Promise.reject(e);
    }
    // Chrome callback style (also works in newer Chrome where promise exists but we got here).
    return new Promise((resolve, reject) => {
        try {
            fn(...args, (result) => {
                const err = extApi.runtime && extApi.runtime.lastError;
                if (err) reject(new Error(err.message || String(err)));
                else resolve(result);
            });
        } catch (e) {
            reject(e);
        }
    });
}

const storageGet = (keys) => _promisify(extApi.storage.local.get.bind(extApi.storage.local), keys);
const storageSet = (obj) => _promisify(extApi.storage.local.set.bind(extApi.storage.local), obj);
const storageRemove = (keys) => _promisify(extApi.storage.local.remove.bind(extApi.storage.local), keys);
const tabsQuery = (info) => _promisify(extApi.tabs.query.bind(extApi.tabs), info);
const tabsGet = (tabId) => _promisify(extApi.tabs.get.bind(extApi.tabs), tabId);
const tabsUpdate = (tabId, props) => _promisify(extApi.tabs.update.bind(extApi.tabs), tabId, props);
const tabsCreate = (props) => _promisify(extApi.tabs.create.bind(extApi.tabs), props);

// Only http(s) may be restored. Blocks `javascript:`, `data:`, `file:` etc.
// crafted as suspended.html#...@<payload>.
function isSafeRestoreUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url);
}

let SUSPEND_DELAY = 60; // seconds; set from storage (minutes -> seconds)
const SUSPENDED_PREFIX = "💤 ";
const SWEEP_INTERVAL_MS = 30000; // single sweeper, no per-tab setTimeout
const MAX_SUSPEND_PER_SWEEP = 10; // batch cap so 2000 due tabs don't freeze the browser

let suspensionEnabled = true;
let screenshotsEnabled = true;
let autoSuspensionEnabled = true;
let activeTabs = {}; // windowId -> tabId
let lastSeen = {}; // tabId -> timestamp (ms) when it became inactive & eligible
let cachedExceptions = []; // normalized strings, loaded once + kept via onChanged
let suspendedTabsCache = null; // in-memory copy of {tabId: {...}}, single writer
let pendingCache = null; // in-memory copy of {tabId: {url,title,savedAt}}, single writer
// Popup reads only the small `pendingSuspends` key — never get(null), which
// would load multi-MB screenshots into the popup.

function normalizeException(s) {
    return (s || "").replace(/^(https?:\/\/)?(www\.)?/, "").replace(/\/$/, "").toLowerCase();
}

// ---- screenshots keyed by URL hash, not tabId ----
// tabIds are session-scoped: after a window close / session restore every tab
// gets a NEW id, so `screenshot_<oldTabId>` never matches again. URL hashes
// are stable across restarts. Must stay in sync with suspended.js copy.
function hashString(str, seed) {
    let h1 = 0xdeadbeef ^ (seed || 0);
    let h2 = 0x41c6ce57 ^ (seed || 0);
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

function screenshotKeyForUrl(url) {
    return `screenshot_${hashString(url || "")}`;
}

function faviconKeyForUrl(url) {
    return `favicon_${hashString(url || "")}`;
}

function buildSuspendedUrl(originalUrl, title, favicon) {
    const base = extApi.runtime.getURL("src/suspended/suspended.html");
    const meta = [
        encodeURIComponent(title || ""),
        encodeURIComponent(favicon || ""),
        encodeURIComponent(SUSPENDED_PREFIX),
        ""
    ].join("|");
    return `${base}#${meta}@${originalUrl}`;
}

// Synchronous, in-memory check. Old code did storage.local.get per tab per
// sweep — that was the real scaling bottleneck, not setTimeout.
function isExceptionCached(url) {
    if (!url || cachedExceptions.length === 0) return false;
    let domain;
    try {
        domain = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch (e) {
        return false;
    }
    if (!domain) return false;
    for (const ex of cachedExceptions) {
        if (!ex) continue;
        // Exact match (e.g. youtube.com === youtube.com) or subdomain match (music.youtube.com endsWith .youtube.com)
        if (domain === ex || domain.endsWith("." + ex)) return true;
    }
    return false;
}

function extractOriginalUrl(suspendedUrl) {
    if (!suspendedUrl) return "";
    // New format (2.x): ...suspended.html#<meta>@<originalUrl>
    const hashAt = suspendedUrl.indexOf("#");
    if (hashAt >= 0) {
        const hash = suspendedUrl.slice(hashAt + 1);
        const at = hash.indexOf("@");
        if (at >= 0) {
            const url = hash.slice(at + 1);
            if (url) return url;
        }
    }
    // Legacy format (<=1.51): ...suspended.html?url=<enc>&title=...
    // Required so tabs suspended before the hash migration can still be
    // restored (Unsuspend Others, click-to-restore, startup recovery).
    // NOTE: regex instead of URLSearchParams — legacy URLs embed a full
    // base64 JPEG in &screenshot= (megabytes). Parsing the whole query on
    // every sweep would be slow with many tabs.
    const legacyMatch = suspendedUrl.match(/[?&]url=([^&]*)/);
    if (legacyMatch && legacyMatch[1]) {
        try {
            return decodeURIComponent(legacyMatch[1]);
        } catch (e) {
            return legacyMatch[1];
        }
    }
    // Fallback for URLs containing a bare "@" (very old edge case).
    const at = suspendedUrl.indexOf("@");
    return at >= 0 ? suspendedUrl.slice(at + 1) : "";
}

function getEffectiveUrl(tab) {
    if (!tab || !tab.url) return "";
    const prefix = extApi.runtime.getURL("src/suspended/suspended.html");
    if (tab.url.startsWith(prefix)) {
        return extractOriginalUrl(tab.url);
    }
    return tab.url;
}

function isEligibleForAutoSuspend(tab, effectiveUrl) {
    if (!tab || tab.active || tab.audible || tab.pinned || tab.discarded) return false;
    if (!tab.url) return false;
    // Raw-URL check first: never schedule anything already internal or
    // already suspended (suspended pages live under the extension origin).
    const extPrefix = extApi.runtime.getURL("");
    if (tab.url.startsWith(extPrefix) ||
        tab.url.startsWith("about:") ||
        tab.url.startsWith("chrome:") ||
        tab.url.startsWith("moz-extension:") ||
        tab.url === "about:blank" ||
        tab.url === "about:newtab") {
        return false;
    }
    // Exception check runs against the effective (original) URL.
    const url = effectiveUrl !== undefined ? effectiveUrl : getEffectiveUrl(tab);
    if (!url || !isSafeRestoreUrl(url)) return false;
    return !isExceptionCached(url);
}

function touch(tabId, now) {
    lastSeen[tabId] = now === undefined ? Date.now() : now;
}

function untouch(tabId) {
    delete lastSeen[tabId];
}

function clearAllTimestamps() {
    lastSeen = {};
}

function updateIcon(active) {
    // Absolute path: relative paths resolve against the calling page
    // (src/background/), not the extension root, in some browsers.
    const path = active ? "/icons/icon_active.png" : "/icons/icon_inactive.png";
    try {
        const p = extApi.browserAction.setIcon({ path });
        if (p && typeof p.catch === "function") p.catch((e) => debug("setIcon failed:", e.message));
    } catch (e) {
        debug("setIcon failed:", e.message);
    }
}

// ---- storage (single initial read, then cache + onChanged) ----

function loadInitialState() {
    storageGet(
        ["suspensionEnabled", "screenshotsEnabled", "autoSuspensionEnabled", "suspensionTimer", "exceptions", "suspendedTabs", "pendingSuspends"]
    ).then((data) => {
            data = data || {};
            suspensionEnabled = data.suspensionEnabled !== false;
            screenshotsEnabled = data.screenshotsEnabled !== false;
            autoSuspensionEnabled = data.autoSuspensionEnabled !== false;
            const totalMinutes = data.suspensionTimer || 1;
            SUSPEND_DELAY = totalMinutes * 60;
            cachedExceptions = (data.exceptions || []).map(normalizeException);
            suspendedTabsCache = data.suspendedTabs || {};
            pendingCache = data.pendingSuspends || {};
            updateIcon(suspensionEnabled);
            seedAllTabs();
            migrateLegacyPendingKeys();
        }).catch((e) => console.error("loadInitialState failed:", e));
}

// One-time migration: old `pending_suspend_<tabId>` keys -> single
// `pendingSuspends` dict so the popup never needs get(null) (which would
// load multi-MB screenshots just to list recovery entries).
function migrateLegacyPendingKeys() {
    storageGet(null).then((all) => {
        if (!all) return;
        const legacy = {};
        const legacyKeys = [];
        for (const [k, v] of Object.entries(all)) {
            if (k.startsWith("pending_suspend_") && v && v.url) {
                const tabId = k.slice("pending_suspend_".length);
                legacy[tabId] = v;
                legacyKeys.push(k);
            }
        }
        if (legacyKeys.length === 0) return;
        if (pendingCache === null) pendingCache = {};
        Object.assign(pendingCache, legacy);
        savePendingCache()
            .then(() => storageRemove(legacyKeys).catch(() => {}))
            .catch(() => {});
    }).catch(() => {});
}

extApi.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.suspensionEnabled) suspensionEnabled = changes.suspensionEnabled.newValue !== false;
    if (changes.screenshotsEnabled) screenshotsEnabled = changes.screenshotsEnabled.newValue !== false;
    if (changes.autoSuspensionEnabled) {
        autoSuspensionEnabled = changes.autoSuspensionEnabled.newValue !== false;
        if (!autoSuspensionEnabled) clearAllTimestamps();
        else seedAllTabs();
    }
    if (changes.suspensionTimer && changes.suspensionTimer.newValue) {
        SUSPEND_DELAY = changes.suspensionTimer.newValue * 60;
        // No timer reset needed: sweeper compares Date.now() - lastSeen lazily.
    }
    if (changes.exceptions) {
        cachedExceptions = (changes.exceptions.newValue || []).map(normalizeException);
    }
    if (changes.suspendedTabs) {
        suspendedTabsCache = changes.suspendedTabs.newValue || {};
    }
    if (changes.pendingSuspends) {
        pendingCache = changes.pendingSuspends.newValue || {};
    }
});

function saveSuspendedTabsCache() {
    return storageSet({ suspendedTabs: suspendedTabsCache || {} });
}

function savePendingCache() {
    return storageSet({ pendingSuspends: pendingCache || {} });
}

const saveOriginalUrl = (tabId, url, title) => {
    if (pendingCache === null) pendingCache = {};
    pendingCache[tabId] = { url, title, savedAt: Date.now() };
    return savePendingCache();
};

const clearPendingUrl = (tabId) => {
    // Delete from new dict + legacy per-tab key (migration stragglers).
    if (pendingCache !== null && pendingCache[tabId]) {
        delete pendingCache[tabId];
        savePendingCache().catch((e) => debug("clearPending failed:", e.message));
    }
    storageRemove(`pending_suspend_${tabId}`).catch(() => {});
};

const addSuspendedTabToStorage = (tabId, url, title, windowId, favicon) => {
    // Single-writer via in-memory cache: avoids read-modify-write races when
    // suspending a batch of tabs.
    if (suspendedTabsCache === null) suspendedTabsCache = {};
    suspendedTabsCache[tabId] = { url, title, windowId, timestamp: Date.now(), favicon: favicon || "" };
    return saveSuspendedTabsCache();
};

const removeSuspendedTabFromStorage = (tabId) => {
    if (suspendedTabsCache !== null) {
        if (suspendedTabsCache[tabId]) {
            delete suspendedTabsCache[tabId];
            return saveSuspendedTabsCache();
        }
        return Promise.resolve();
    }
    return storageGet("suspendedTabs").then((data) => {
        const tabs = (data && data.suspendedTabs) || {};
        if (tabs[tabId]) {
            delete tabs[tabId];
            suspendedTabsCache = tabs;
            return saveSuspendedTabsCache();
        }
    }).catch((e) => debug("removeSuspendedTab failed:", e.message));
};

// ---- core suspend ----

// Capture a screenshot for `tab` without ever capturing the WRONG tab.
// Firefox: tabs.captureTab(tabId) can capture a background tab.
// Chrome: only tabs.captureVisibleTab(windowId) exists and it captures the
//   VISIBLE tab of that window. Calling it for a background tab would
//   screenshot the active tab instead — so we only capture when tab.active.
async function captureScreenshotForTab(tab) {
    if (!screenshotsEnabled) return "";
    try {
        if (extApi.tabs.captureTab) {
            // Firefox path: true per-tab capture.
            return await _promisify(extApi.tabs.captureTab.bind(extApi.tabs), tab.id, { format: "jpeg", quality: 50 });
        }
        // Chrome path: only the visible tab can be captured.
        if (tab.active && extApi.tabs.captureVisibleTab) {
            return await _promisify(extApi.tabs.captureVisibleTab.bind(extApi.tabs), tab.windowId, { format: "jpeg", quality: 50 });
        }
        return "";
    } catch (e) {
        debug("screenshot capture failed:", e.message);
        return "";
    }
}

async function suspendTab(tabId) {
    if (!suspensionEnabled) throw new Error("Suspension is disabled");

    const tab = await tabsGet(tabId);
    if (!tab.url) throw new Error("Tab has no URL");

    const effectiveUrl = getEffectiveUrl(tab);
    const prefix = extApi.runtime.getURL("");
    if (tab.audible ||
        tab.discarded ||
        tab.url.startsWith(prefix) ||
        tab.url.startsWith("about:") ||
        tab.url.startsWith("chrome:") ||
        tab.url.startsWith("moz-extension:") ||
        tab.url === "about:blank" ||
        tab.url === "about:newtab" ||
        !isSafeRestoreUrl(effectiveUrl || tab.url) ||
        isExceptionCached(effectiveUrl)) {
        untouch(tabId);
        throw new Error("Tab not eligible for suspension");
    }

    const createSuspendedUrl = async (screenshotUrl = "") => {
        const base = extApi.runtime.getURL("src/suspended/suspended.html");
        const favicon = tab.favIconUrl || "";
        if (screenshotUrl) {
            try {
                // Stable key: survives window close / session restore where
                // tabIds change. Legacy `screenshot_<tabId>` fallback is read
                // by suspended.js but no longer written.
                await storageSet({ [screenshotKeyForUrl(tab.url)]: screenshotUrl });
            } catch (e) {
                // Quota exceeded (5MB local): suspend anyway, just no preview.
                debug("screenshot save failed (quota?):", e.message);
            }
        }
        if (favicon) {
            try {
                // Stable key so session restores (new tabIds) still find the
                // icon. Tiny strings, safe to keep alongside screenshots.
                // Also write legacy tabId key for old suspended.js readers.
                await storageSet({
                    [faviconKeyForUrl(tab.url)]: favicon,
                    [`favicon_${tabId}`]: favicon
                });
            } catch (e) {
                debug("favicon save failed:", e.message);
            }
        }
        // Embed small http(s) favicons directly in the hash so the tab icon
        // shows instantly (before the async storage read in suspended.js).
        // data: URLs can be large — leave those to storage only.
        const embedFavicon = favicon && !favicon.startsWith("data:") && favicon.length < 1500
            ? favicon
            : "";
        const meta = [
            encodeURIComponent(tab.title || ""),
            encodeURIComponent(embedFavicon),
            encodeURIComponent(SUSPENDED_PREFIX),
            tabId
        ].join("|");
        return `${base}#${meta}@${tab.url}`;
    };

    const updateTabToSuspended = async (screenshotUrl) => {
        const suspendedUrl = await createSuspendedUrl(screenshotUrl);
        await saveOriginalUrl(tabId, tab.url, tab.title);
        await addSuspendedTabToStorage(tabId, tab.url, tab.title, tab.windowId, tab.favIconUrl || "");
        try {
            await tabsUpdate(tabId, { url: suspendedUrl });
        } catch (error) {
            await removeSuspendedTabFromStorage(tabId);
            clearPendingUrl(tabId);
            throw error;
        }
        untouch(tabId);
        clearPendingUrl(tabId);
    };

    // Screenshot failure must never block suspension (bulk sweeps especially).
    // captureScreenshotForTab returns "" when capture is impossible (e.g.
    // background tab in Chrome) instead of capturing the wrong tab.
    const screenshotUrl = await captureScreenshotForTab(tab);
    await updateTabToSuspended(screenshotUrl || undefined);
}

// Sequential + capped: capture + tabs.update for hundreds of tabs at once
// freezes the browser. Callers (sweep, suspend-other) share this helper.
async function suspendBatch(tabs, reason) {
    let suspended = 0;
    let skipped = 0;
    for (const tab of tabs) {
        try {
            await suspendTab(tab.id);
            suspended++;
        } catch (e) {
            skipped++;
            debug(`[${reason}] skip tab ${tab.id}:`, e.message);
        }
    }
    if (suspended > 0 || DEBUG) console.log(`[${reason}] suspended=${suspended} skipped=${skipped}`);
    return { suspended, skipped };
}

function suspendOtherTabs() {
    if (!suspensionEnabled) return Promise.reject(new Error("Suspension is disabled"));

    return tabsQuery({ currentWindow: true }).then(async (tabs) => {
        const activeTab = tabs.find((tab) => tab.active);
        if (!activeTab) throw new Error("No active tab found");

        const prefix = extApi.runtime.getURL("");
        const candidates = tabs.filter((tab) => {
            if (tab.id === activeTab.id || tab.audible || tab.pinned || tab.discarded) return false;
            if (!tab.url) return false;
            if (tab.url.startsWith(prefix) ||
                tab.url.startsWith("about:") ||
                tab.url.startsWith("chrome:") ||
                tab.url.startsWith("moz-extension:") ||
                tab.url === "about:blank" ||
                tab.url === "about:newtab") return false;
            const effective = getEffectiveUrl(tab);
            if (!isSafeRestoreUrl(effective || tab.url)) return false;
            return !isExceptionCached(effective);
        });

        if (candidates.length === 0) return { suspended: 0, skipped: tabs.length - 1 };
        // Manual action: suspend everything requested, sequentially (no cap).
        // The automatic sweep is the one capped per interval.
        return suspendBatch(candidates, "suspend-other");
    });
}

// ---- unsuspend ----

function isSuspendedTabUrl(url) {
    return !!url && url.startsWith(extApi.runtime.getURL("src/suspended/suspended.html"));
}

async function unsuspendTab(tabId) {
    const tab = await tabsGet(tabId);
    if (!isSuspendedTabUrl(tab.url)) throw new Error("Tab is not suspended");
    const originalUrl = extractOriginalUrl(tab.url);
    if (!originalUrl || !isSafeRestoreUrl(originalUrl)) throw new Error("Suspended tab has no valid original URL");
    await tabsUpdate(tabId, { url: originalUrl });
    await removeSuspendedTabFromStorage(tabId);
    // Screenshots now persist across views/restores — delete only on real
    // restore. Remove both the stable URL-hash key and legacy tabId keys.
    storageRemove([
        screenshotKeyForUrl(originalUrl),
        faviconKeyForUrl(originalUrl),
        `screenshot_${tabId}`,
        `favicon_${tabId}`
    ]).catch((e) => debug("cleanup after unsuspend failed:", e.message));
    clearPendingUrl(tabId);
    // Restored tab starts aging for auto-suspension from now.
    if (suspensionEnabled && autoSuspensionEnabled) touch(tabId);
    else untouch(tabId);
}

async function unsuspendOtherTabs() {
    const tabs = await tabsQuery({ currentWindow: true });
    const activeTab = tabs.find((tab) => tab.active);
    if (!activeTab) throw new Error("No active tab found");
    const candidates = tabs.filter((tab) => tab.id !== activeTab.id && isSuspendedTabUrl(tab.url));
    let restored = 0;
    let skipped = 0;
    // Sequential: each restore triggers a real page load; firing hundreds
    // at once spikes CPU/memory.
    for (const tab of candidates) {
        try {
            await unsuspendTab(tab.id);
            restored++;
        } catch (e) {
            skipped++;
            debug(`[unsuspend-other] skip tab ${tab.id}:`, e.message);
        }
    }
    if (restored > 0 || DEBUG) console.log(`[unsuspend-other] restored=${restored} skipped=${skipped}`);
    return { restored, skipped };
}

// ---- timestamp seeding + single sweeper (replaces per-tab setTimeout) ----

async function seedAllTabs() {
    if (!suspensionEnabled || !autoSuspensionEnabled) return;
    try {
        const tabs = await tabsQuery({});
        const now = Date.now();
        for (const tab of tabs) {
            if (isEligibleForAutoSuspend(tab)) {
                if (lastSeen[tab.id] === undefined) touch(tab.id, now);
            } else {
                untouch(tab.id);
            }
        }
    } catch (e) {
        console.error("seedAllTabs failed:", e);
    }
}

async function sweepOnce() {
    if (!suspensionEnabled || !autoSuspensionEnabled) return;
    let tabs;
    try {
        tabs = await tabsQuery({});
    } catch (e) {
        console.error("sweep query failed:", e);
        return;
    }
    const now = Date.now();
    const delayMs = SUSPEND_DELAY * 1000;
    const due = [];
    for (const tab of tabs) {
        if (tab.active || tab.audible) {
            if (lastSeen[tab.id] !== undefined) untouch(tab.id);
            continue;
        }
        if (!isEligibleForAutoSuspend(tab)) {
            if (lastSeen[tab.id] !== undefined) untouch(tab.id);
            continue;
        }
        if (lastSeen[tab.id] === undefined) {
            // Seen but never timestamped (new tab, startup) — start aging now,
            // don't suspend immediately to avoid mass-suspend on reload.
            touch(tab.id, now);
            continue;
        }
        if (now - lastSeen[tab.id] >= delayMs) due.push(tab);
    }
    if (due.length === 0) {
        debug(`sweep: ${tabs.length} tabs, none due`);
        return;
    }
    // Oldest first, capped per sweep so the browser stays responsive.
    due.sort((a, b) => (lastSeen[a.id] || 0) - (lastSeen[b.id] || 0));
    await suspendBatch(due.slice(0, MAX_SUSPEND_PER_SWEEP), "sweep");
}

// ---- events: just maintain timestamps, never create timers ----

tabsQuery({ active: true }).then((tabs) => {
    tabs.forEach((tab) => {
        activeTabs[tab.windowId] = tab.id;
    });
}).catch((e) => debug("initial activeTabs query failed:", e.message));

extApi.commands.onCommand.addListener((command) => {
    if (command === "suspend-tab" && suspensionEnabled) {
        tabsQuery({ active: true, currentWindow: true }).then((tabs) => {
            if (tabs.length > 0) suspendTab(tabs[0].id).catch((e) => debug("suspend-tab:", e.message));
        }).catch((e) => debug("suspend-tab query failed:", e.message));
    } else if (command === "suspend-other-tabs" && suspensionEnabled) {
        suspendOtherTabs().catch((error) => console.error("Error suspending other tabs:", error));
    }
});

// removeAll first: re-creating the same IDs on reload otherwise throws.
if (extApi.contextMenus && extApi.contextMenus.removeAll) {
    _promisify(extApi.contextMenus.removeAll.bind(extApi.contextMenus)).then(() => {
        try {
            extApi.contextMenus.create({ id: "suspend-tab", title: "Suspend This Tab", contexts: ["page", "tab"] });
            extApi.contextMenus.create({ id: "suspend-other-tabs", title: "Suspend All Other Tabs", contexts: ["page", "tab"] });
            extApi.contextMenus.create({ id: "suspend-selected-tabs", title: "Suspend Selected Tabs", contexts: ["tab"] });
        } catch (e) {
            debug("contextMenus create failed:", e.message);
        }
    }).catch((e) => debug("contextMenus setup failed:", e.message));
}

extApi.contextMenus.onClicked.addListener((info, tab) => {
    if (!suspensionEnabled) return;
    if (info.menuItemId === "suspend-tab" && tab && tab.id) {
        suspendTab(tab.id).catch((error) => debug("context suspend-tab:", error.message));
    } else if (info.menuItemId === "suspend-other-tabs") {
        suspendOtherTabs().catch((error) => console.error("Error suspending other tabs:", error));
    } else if (info.menuItemId === "suspend-selected-tabs" && tab && tab.id) {
        tabsQuery({ highlighted: true, currentWindow: true }).then((tabs) => {
            // Never suspend the tab the user is currently looking at via a
            // bulk action — that navigates away the active page. Single
            // "Suspend This Tab" still allows it explicitly.
            suspendBatch(tabs.filter((t) => t.id && !t.active), "suspend-selected");
        }).catch((e) => debug("suspend-selected query failed:", e.message));
    }
});

extApi.tabs.onActivated.addListener((activeInfo) => {
    const prevTabId = activeTabs[activeInfo.windowId];
    if (prevTabId && prevTabId !== activeInfo.tabId) {
        // Previously visible tab starts aging now (if eligible).
        tabsGet(prevTabId).then((prev) => {
            if (suspensionEnabled && autoSuspensionEnabled && isEligibleForAutoSuspend({ ...prev, active: false })) {
                touch(prevTabId);
            }
        }).catch(() => untouch(prevTabId)); // tab already closed
    }
    activeTabs[activeInfo.windowId] = activeInfo.tabId;
    untouch(activeInfo.tabId);
});

extApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && !isSuspendedTabUrl(changeInfo.url)) {
        removeSuspendedTabFromStorage(tabId);
    }
    if (!suspensionEnabled || !autoSuspensionEnabled) return;
    if (changeInfo.audible === true || tab.audible) {
        untouch(tabId);
    } else if (changeInfo.status === "complete" || changeInfo.audible === false) {
        if (!tab.active && isEligibleForAutoSuspend(tab)) {
            if (lastSeen[tabId] === undefined) touch(tabId);
        } else {
            untouch(tabId);
        }
    }
});

extApi.tabs.onRemoved.addListener((tabId, removeInfo) => {
    untouch(tabId);
    removeSuspendedTabFromStorage(tabId);
    if (activeTabs[removeInfo.windowId] === tabId) {
        delete activeTabs[removeInfo.windowId];
        // Query the newly active tab in that window so activeTabs stays accurate
        tabsQuery({ active: true, windowId: removeInfo.windowId }).then((tabs) => {
            if (tabs.length > 0) {
                activeTabs[removeInfo.windowId] = tabs[0].id;
                untouch(tabs[0].id);
            }
        }).catch(() => {});
    }
});

if (extApi.windows && extApi.windows.onFocusChanged) {
    let lastFocusedWindowId = extApi.windows.WINDOW_ID_NONE;
    extApi.windows.onFocusChanged.addListener((windowId) => {
        if (windowId === extApi.windows.WINDOW_ID_NONE) {
            lastFocusedWindowId = windowId;
            return;
        }
        // When switching windows, the active tab in the previous window is now backgrounded
        // NOTE: WINDOW_ID_NONE is -1 (truthy), so compare explicitly.
        if (lastFocusedWindowId !== extApi.windows.WINDOW_ID_NONE && lastFocusedWindowId !== windowId) {
            const prevWindowTabId = activeTabs[lastFocusedWindowId];
            if (prevWindowTabId) {
                tabsGet(prevWindowTabId).then((prev) => {
                    if (suspensionEnabled && autoSuspensionEnabled && isEligibleForAutoSuspend({ ...prev, active: false })) {
                        touch(prevWindowTabId);
                    }
                }).catch(() => untouch(prevWindowTabId));
            }
        }
        lastFocusedWindowId = windowId;
        // Tab in newly focused window is now in active view
        const currentActiveTabId = activeTabs[windowId];
        if (currentActiveTabId) {
            untouch(currentActiveTabId);
        } else {
            tabsQuery({ active: true, windowId }).then((tabs) => {
                if (tabs.length > 0) {
                    activeTabs[windowId] = tabs[0].id;
                    untouch(tabs[0].id);
                }
            }).catch(() => {});
        }
    });
}

extApi.runtime.onConnect.addListener((port) => {
    if (port.name === "suspended-tab") {
        debug("Suspended tab connected");
    }
});

// ---- messages ----

extApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "suspendTab") {
        if (!suspensionEnabled) {
            sendResponse({ success: false, error: "Suspension is disabled" });
            return;
        }
        tabsQuery({ active: true, currentWindow: true }).then((tabs) => {
            if (tabs.length > 0) {
                suspendTab(tabs[0].id)
                    .then(() => sendResponse({ success: true }))
                    .catch((error) => sendResponse({ success: false, error: error.message }));
            } else {
                sendResponse({ success: false, error: "No active tab found" });
            }
        }).catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

    } else if (message.action === "suspendOtherTabs") {
        if (!suspensionEnabled) {
            sendResponse({ success: false, error: "Suspension is disabled" });
            return;
        }
        suspendOtherTabs()
            .then((result) => sendResponse({ success: true, suspended: result.suspended, skipped: result.skipped }))
            .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

    } else if (message.action === "unsuspendOtherTabs") {
        // No suspensionEnabled gate: restoring tabs must always work.
        unsuspendOtherTabs()
            .then((result) => sendResponse({ success: true, restored: result.restored, skipped: result.skipped }))
            .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

    } else if (message.action === "screenshotConsumed") {
        // Click-to-restore from the suspended page: that navigation bypasses
        // unsuspendTab(), so delete the screenshot here. Fire-and-forget.
        // Validate: ignore crafted non-http(s) payloads.
        if (message.url && isSafeRestoreUrl(message.url)) {
            storageRemove([
                screenshotKeyForUrl(message.url),
                faviconKeyForUrl(message.url)
            ]).catch(() => {});
            if (sender && sender.tab && sender.tab.id !== undefined) {
                storageRemove([`screenshot_${sender.tab.id}`, `favicon_${sender.tab.id}`]).catch(() => {});
                removeSuspendedTabFromStorage(sender.tab.id);
            }
        }
        return false;

    } else if (message.action === "updateTimer") {
        const totalMinutes = message.value;
        SUSPEND_DELAY = totalMinutes * 60;
        // Persist; onChanged listener picks it up in all contexts.
        // No timestamp reset: existing lastSeen values are reused, the new
        // delay applies lazily on the next sweep.
        storageSet({ suspensionTimer: totalMinutes }).catch((e) => debug("updateTimer persist failed:", e.message));
    } else if (message.action === "toggleSuspension") {
        suspensionEnabled = message.enabled;
        if (!suspensionEnabled) {
            clearAllTimestamps();
        } else if (autoSuspensionEnabled) {
            seedAllTabs();
        }
        updateIcon(suspensionEnabled);

    } else if (message.action === "toggleAutoSuspension") {
        autoSuspensionEnabled = message.enabled;
        if (!autoSuspensionEnabled) {
            clearAllTimestamps();
        } else {
            seedAllTabs();
        }

    } else if (message.action === "toggleScreenshots") {
        screenshotsEnabled = message.enabled;
        storageSet({ screenshotsEnabled }).catch((e) => debug("toggleScreenshots persist failed:", e.message));

    } else if (message.action === "updateIcon") {
        updateIcon(message.active);
    }
});

setInterval(sweepOnce, SWEEP_INTERVAL_MS);
// NOTE: MV2 persistent background can hold this interval. If/when migrating
// to MV3 (service worker), replace with chrome.alarms — workers are killed
// after ~30s and all setTimeout/setInterval state is lost.

// Restore all suspended tabs when the extension is unloaded/reloaded
if (extApi.runtime.onSuspend) {
    extApi.runtime.onSuspend.addListener(() => {
        tabsQuery({}).then((tabs) => {
            tabs.forEach((tab) => {
                if (isSuspendedTabUrl(tab.url)) {
                    const originalUrl = extractOriginalUrl(tab.url);
                    if (originalUrl && isSafeRestoreUrl(originalUrl)) tabsUpdate(tab.id, { url: originalUrl }).catch(() => {});
                }
            });
        }).catch(() => {});
    });
}

function restoreClosedSuspendedTabs() {
    const read = suspendedTabsCache !== null
        ? Promise.resolve(suspendedTabsCache)
        : storageGet("suspendedTabs").then((d) => (suspendedTabsCache = (d && d.suspendedTabs) || {}));
    read.then((suspendedTabs) => {
        if (Object.keys(suspendedTabs).length === 0) {
            cleanupOrphanScreenshots();
            return;
        }
        tabsQuery({}).then((tabs) => {
            const openTabIds = new Set(tabs.map((tab) => tab.id));
            // URLs already open (live or suspended) must not be duplicated.
            const openUrls = new Set();
            tabs.forEach((tab) => {
                openUrls.add(tab.url);
                if (isSuspendedTabUrl(tab.url)) openUrls.add(extractOriginalUrl(tab.url));
            });
            const closedTabs = [];
            Object.keys(suspendedTabs).forEach((tabIdStr) => {
                const tabId = parseInt(tabIdStr, 10);
                const entry = suspendedTabs[tabIdStr];
                if (!entry || !entry.url || !isSafeRestoreUrl(entry.url)) {
                    // Drop unsafe/stale entries (e.g. crafted javascript: URLs).
                    if (entry && entry.url && !isSafeRestoreUrl(entry.url)) removeSuspendedTabFromStorage(tabId);
                    return;
                }
                if (!openTabIds.has(tabId) && !openUrls.has(entry.url)) {
                    closedTabs.push({ tabId, ...entry });
                } else if (!openTabIds.has(tabId)) {
                    // Stale id for an already-open URL: drop without restore.
                    removeSuspendedTabFromStorage(tabId);
                }
            });
            if (closedTabs.length > 0) {
                console.log(`Restoring ${closedTabs.length} suspended tabs that were closed...`);
                // Sequential restore: tabs.create in a tight loop with 1000+
                // tabs spikes CPU/memory.
                (async () => {
                    let dirty = false;
                    for (const closedTab of closedTabs) {
                        try {
                            // Restore as a SUSPENDED page (not the live URL) so
                            // the saved screenshot (keyed by URL hash) still
                            // displays. Screenshot stays until real restore.
                            // Favicon (URL-hash key + embedded meta) restores
                            // the tab icon the same way.
                            const suspendedUrl = buildSuspendedUrl(closedTab.url, closedTab.title, closedTab.favicon || "");
                            let newTab;
                            try {
                                newTab = await tabsCreate({ url: suspendedUrl, windowId: closedTab.windowId, active: false });
                            } catch (e) {
                                // windowId gone (window was closed): open in a
                                // current window instead.
                                newTab = await tabsCreate({ url: suspendedUrl, active: false });
                            }
                            if (suspendedTabsCache === null) suspendedTabsCache = { ...suspendedTabs };
                            if (newTab && newTab.id !== undefined) {
                                suspendedTabsCache[newTab.id] = { url: closedTab.url, title: closedTab.title, windowId: newTab.windowId, timestamp: Date.now(), favicon: closedTab.favicon || "" };
                            }
                            delete suspendedTabsCache[closedTab.tabId];
                            dirty = true;
                        } catch (e) {
                            debug("restore failed:", closedTab.url, e.message);
                        }
                    }
                    // Single write instead of one set() per restored tab.
                    if (dirty) {
                        try { await saveSuspendedTabsCache(); } catch (e) { debug("restore save failed:", e.message); }
                    }
                    cleanupOrphanScreenshots();
                })();
            } else {
                cleanupOrphanScreenshots();
            }
        });
    });
}

// Screenshots persist until real restore, so crash leftovers could grow
// unbounded (5MB local quota). Keep only screenshots for currently-suspended
// or registered URLs; drop the rest.
// NOTE: storage has no keys-only listing, so get(null) loads values into
// memory. This runs once at startup / after restores only — never per sweep.
function cleanupOrphanScreenshots(knownHashes) {
    const collect = () => {
        if (knownHashes) return Promise.resolve({ hashes: knownHashes, openNumericIds: new Set() });
        return tabsQuery({}).then((tabs) => {
            const hashes = new Set();
            const openNumericIds = new Set(tabs.map((t) => t.id));
            tabs.forEach((tab) => {
                if (isSuspendedTabUrl(tab.url)) {
                    const original = extractOriginalUrl(tab.url);
                    if (original && isSafeRestoreUrl(original)) hashes.add(hashString(original));
                }
            });
            const cache = suspendedTabsCache || {};
            Object.values(cache).forEach((entry) => {
                if (entry && entry.url && isSafeRestoreUrl(entry.url)) hashes.add(hashString(entry.url));
            });
            return { hashes, openNumericIds };
        });
    };
    collect().then(({ hashes, openNumericIds }) => {
        storageGet(null).then((all) => {
            all = all || {};
            const orphans = Object.keys(all).filter((k) => {
                const isScreenshot = k.startsWith("screenshot_");
                const isFavicon = k.startsWith("favicon_");
                if (!isScreenshot && !isFavicon) return false;
                if (k.startsWith("pending_suspend_")) return false;
                const prefixLen = isScreenshot ? "screenshot_".length : "favicon_".length;
                // Legacy numeric keys (screenshot_<tabId>, favicon_<tabId>):
                // keep while that tab is still open (old-format suspended tab
                // may still reference it); delete once the tab is gone.
                const m = k.match(/^(screenshot|favicon)_(\d+)$/);
                if (m) return !openNumericIds.has(parseInt(m[2], 10));
                const hash = k.slice(prefixLen);
                return !hashes.has(hash);
            });
            if (orphans.length > 0) {
                debug(`cleaning ${orphans.length} orphan screenshots/favicons`);
                // Delete in chunks so a huge backlog doesn't block the background page.
                const CHUNK = 50;
                (async () => {
                    for (let i = 0; i < orphans.length; i += CHUNK) {
                        try { await storageRemove(orphans.slice(i, i + CHUNK)); } catch (e) { debug("orphan chunk delete failed:", e.message); break; }
                    }
                })();
            }
        }).catch((e) => debug("orphan cleanup failed:", e.message));
    }).catch((e) => debug("orphan cleanup failed:", e.message));
}

function cleanupStalePendingSuspends() {
    // Uses the small `pendingSuspends` dict only — never get(null), which
    // would load multi-MB screenshots. Legacy per-tab keys are migrated in
    // migrateLegacyPendingKeys().
    const clean = (pending) => {
        pending = pending || {};
        const now = Date.now();
        const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
        let dirty = false;
        for (const [tabId, value] of Object.entries(pending)) {
            if (!value || !value.savedAt || (now - value.savedAt > maxAgeMs)) {
                delete pending[tabId];
                dirty = true;
            }
        }
        if (dirty) {
            pendingCache = pending;
            savePendingCache().catch((e) => debug("stale pending cleanup failed:", e.message));
        }
    };
    if (pendingCache !== null) clean(pendingCache);
    else storageGet("pendingSuspends").then((d) => {
        pendingCache = (d && d.pendingSuspends) || {};
        clean(pendingCache);
    }).catch((e) => debug("stale pending cleanup failed:", e.message));
}

// Startup
loadInitialState();
setTimeout(() => {
    restoreClosedSuspendedTabs();
    cleanupStalePendingSuspends();
}, 1500);
updateIcon(suspensionEnabled);
