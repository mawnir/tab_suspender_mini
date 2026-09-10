console.log("Tab Suspender extension loaded");

// Set true while debugging. Keep false by default: per-tab logging is what
// kills performance with hundreds/thousands of tabs (I/O + string building
// on every event/sweep).
const DEBUG = false;
const debug = (...args) => { if (DEBUG) console.log(...args); };

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

function buildSuspendedUrl(originalUrl, title) {
    const base = browser.runtime.getURL("src/suspended/suspended.html");
    const meta = [
        encodeURIComponent(title || ""),
        "",
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
        if (domain.includes(ex) || ex.includes(domain)) return true;
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
    const prefix = browser.runtime.getURL("src/suspended/suspended.html");
    if (tab.url.startsWith(prefix)) {
        return extractOriginalUrl(tab.url);
    }
    return tab.url;
}

function isEligibleForAutoSuspend(tab, effectiveUrl) {
    if (!tab || tab.active || tab.audible) return false;
    if (!tab.url) return false;
    // Raw-URL check first: never schedule anything already internal or
    // already suspended (suspended pages live under the extension origin).
    const extPrefix = browser.runtime.getURL("");
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
    if (!url) return false;
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
    const path = active ? "icons/icon_active.png" : "icons/icon_inactive.png";
    browser.browserAction.setIcon({ path });
}

// ---- storage (single initial read, then cache + onChanged) ----

function loadInitialState() {
    browser.storage.local.get(
        ["suspensionEnabled", "screenshotsEnabled", "autoSuspensionEnabled", "suspensionTimer", "exceptions", "suspendedTabs"],
        (data) => {
            suspensionEnabled = data.suspensionEnabled !== false;
            screenshotsEnabled = data.screenshotsEnabled !== false;
            autoSuspensionEnabled = data.autoSuspensionEnabled !== false;
            const totalMinutes = data.suspensionTimer || 1;
            SUSPEND_DELAY = totalMinutes * 60;
            cachedExceptions = (data.exceptions || []).map(normalizeException);
            suspendedTabsCache = data.suspendedTabs || {};
            updateIcon(suspensionEnabled);
            seedAllTabs();
        }
    );
}

browser.storage.onChanged.addListener((changes, area) => {
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
});

function saveSuspendedTabsCache() {
    return browser.storage.local.set({ suspendedTabs: suspendedTabsCache || {} });
}

const saveOriginalUrl = (tabId, url, title) => {
    return browser.storage.local.set({
        [`pending_suspend_${tabId}`]: { url, title, savedAt: Date.now() }
    });
};

const clearPendingUrl = (tabId) => {
    browser.storage.local.remove(`pending_suspend_${tabId}`);
};

const addSuspendedTabToStorage = (tabId, url, title, windowId) => {
    // Single-writer via in-memory cache: avoids read-modify-write races when
    // suspending a batch of tabs.
    if (suspendedTabsCache === null) suspendedTabsCache = {};
    suspendedTabsCache[tabId] = { url, title, windowId, timestamp: Date.now() };
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
    return new Promise((resolve) => {
        browser.storage.local.get("suspendedTabs", (data) => {
            const tabs = data.suspendedTabs || {};
            if (tabs[tabId]) {
                delete tabs[tabId];
                browser.storage.local.set({ suspendedTabs: tabs }, resolve);
            } else {
                resolve();
            }
        });
    });
};

// ---- core suspend ----

async function suspendTab(tabId) {
    if (!suspensionEnabled) throw new Error("Suspension is disabled");

    const tab = await browser.tabs.get(tabId);
    if (!tab.url) throw new Error("Tab has no URL");

    const effectiveUrl = getEffectiveUrl(tab);
    const prefix = browser.runtime.getURL("");
    if (tab.audible ||
        tab.url.startsWith(prefix) ||
        tab.url.startsWith("about:") ||
        tab.url.startsWith("chrome:") ||
        tab.url.startsWith("moz-extension:") ||
        tab.url === "about:blank" ||
        tab.url === "about:newtab" ||
        isExceptionCached(effectiveUrl)) {
        untouch(tabId);
        throw new Error("Tab not eligible for suspension");
    }

    const createSuspendedUrl = async (screenshotUrl = "") => {
        const base = browser.runtime.getURL("src/suspended/suspended.html");
        if (screenshotUrl) {
            try {
                // Stable key: survives window close / session restore where
                // tabIds change. Legacy `screenshot_<tabId>` fallback is read
                // by suspended.js but no longer written.
                await browser.storage.local.set({ [screenshotKeyForUrl(tab.url)]: screenshotUrl });
            } catch (e) {
                // Quota exceeded (5MB local): suspend anyway, just no preview.
                debug("screenshot save failed (quota?):", e.message);
            }
        }
        const meta = [
            encodeURIComponent(tab.title || ""),
            "",
            encodeURIComponent(SUSPENDED_PREFIX),
            tabId
        ].join("|");
        return `${base}#${meta}@${tab.url}`;
    };

    const updateTabToSuspended = async (screenshotUrl) => {
        const suspendedUrl = await createSuspendedUrl(screenshotUrl);
        await saveOriginalUrl(tabId, tab.url, tab.title);
        await addSuspendedTabToStorage(tabId, tab.url, tab.title, tab.windowId);
        try {
            await browser.tabs.update(tabId, { url: suspendedUrl });
        } catch (error) {
            await removeSuspendedTabFromStorage(tabId);
            await clearPendingUrl(tabId);
            throw error;
        }
        untouch(tabId);
        clearPendingUrl(tabId);
    };

    if (screenshotsEnabled) {
        try {
            const screenshotUrl = await browser.tabs.captureTab(tabId, { format: "jpeg", quality: 50 });
            await updateTabToSuspended(screenshotUrl);
        } catch (e) {
            // Screenshot failure must not block suspension (bulk sweeps especially).
            await updateTabToSuspended();
        }
    } else {
        await updateTabToSuspended();
    }
}

// Sequential + capped: captureTab + tabs.update for hundreds of tabs at once
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

    return browser.tabs.query({ currentWindow: true }).then(async (tabs) => {
        const activeTab = tabs.find((tab) => tab.active);
        if (!activeTab) throw new Error("No active tab found");

        const prefix = browser.runtime.getURL("");
        const candidates = tabs.filter((tab) =>
            tab.id !== activeTab.id &&
            !tab.audible &&
            tab.url &&
            !tab.url.startsWith(prefix) &&
            !tab.url.startsWith("about:") &&
            !tab.url.startsWith("chrome:") &&
            !tab.url.startsWith("moz-extension:") &&
            tab.url !== "about:blank" &&
            tab.url !== "about:newtab" &&
            !isExceptionCached(getEffectiveUrl(tab))
        );

        if (candidates.length === 0) return { suspended: 0, skipped: tabs.length - 1 };
        // Manual action: suspend everything requested, sequentially (no cap).
        // The automatic sweep is the one capped per interval.
        return suspendBatch(candidates, "suspend-other");
    });
}

// ---- unsuspend ----

function isSuspendedTabUrl(url) {
    return !!url && url.startsWith(browser.runtime.getURL("src/suspended/suspended.html"));
}

async function unsuspendTab(tabId) {
    const tab = await browser.tabs.get(tabId);
    if (!isSuspendedTabUrl(tab.url)) throw new Error("Tab is not suspended");
    const originalUrl = extractOriginalUrl(tab.url);
    if (!originalUrl) throw new Error("Suspended tab has no original URL");
    await browser.tabs.update(tabId, { url: originalUrl });
    await removeSuspendedTabFromStorage(tabId);
    // Screenshots now persist across views/restores — delete only on real
    // restore. Remove both the stable URL-hash key and legacy tabId keys.
    browser.storage.local.remove([
        screenshotKeyForUrl(originalUrl),
        `screenshot_${tabId}`,
        `favicon_${tabId}`,
        `pending_suspend_${tabId}`
    ]);
    // Restored tab starts aging for auto-suspension from now.
    if (suspensionEnabled && autoSuspensionEnabled) touch(tabId);
    else untouch(tabId);
}

async function unsuspendOtherTabs() {
    const tabs = await browser.tabs.query({ currentWindow: true });
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
        const tabs = await browser.tabs.query({});
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
        tabs = await browser.tabs.query({});
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

browser.tabs.query({ active: true }).then((tabs) => {
    tabs.forEach((tab) => {
        activeTabs[tab.windowId] = tab.id;
    });
});

browser.commands.onCommand.addListener((command) => {
    if (command === "suspend-tab" && suspensionEnabled) {
        browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
            if (tabs.length > 0) suspendTab(tabs[0].id).catch((e) => debug("suspend-tab:", e.message));
        });
    } else if (command === "suspend-other-tabs" && suspensionEnabled) {
        suspendOtherTabs().catch((error) => console.error("Error suspending other tabs:", error));
    }
});

browser.contextMenus.create({
    id: "suspend-tab",
    title: "Suspend This Tab",
    contexts: ["page", "tab"]
});

browser.contextMenus.create({
    id: "suspend-other-tabs",
    title: "Suspend All Other Tabs",
    contexts: ["page", "tab"]
});

browser.contextMenus.create({
    id: "suspend-selected-tabs",
    title: "Suspend Selected Tabs",
    contexts: ["tab"]
});

browser.contextMenus.onClicked.addListener((info, tab) => {
    if (!suspensionEnabled) return;
    if (info.menuItemId === "suspend-tab" && tab && tab.id) {
        suspendTab(tab.id).catch((error) => debug("context suspend-tab:", error.message));
    } else if (info.menuItemId === "suspend-other-tabs") {
        suspendOtherTabs().catch((error) => console.error("Error suspending other tabs:", error));
    } else if (info.menuItemId === "suspend-selected-tabs" && tab && tab.id) {
        browser.tabs.query({ highlighted: true, currentWindow: true }).then((tabs) => {
            suspendBatch(tabs.filter((t) => t.id), "suspend-selected");
        });
    }
});

browser.tabs.onActivated.addListener((activeInfo) => {
    const prevTabId = activeTabs[activeInfo.windowId];
    if (prevTabId && prevTabId !== activeInfo.tabId) {
        // Previously visible tab starts aging now (if eligible).
        browser.tabs.get(prevTabId).then((prev) => {
            if (suspensionEnabled && autoSuspensionEnabled && isEligibleForAutoSuspend({ ...prev, active: false })) {
                touch(prevTabId);
            }
        }).catch(() => untouch(prevTabId)); // tab already closed
    }
    activeTabs[activeInfo.windowId] = activeInfo.tabId;
    untouch(activeInfo.tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && !isSuspendedTabUrl(changeInfo.url)) {
        removeSuspendedTabFromStorage(tabId);
    }
    if (!suspensionEnabled || !autoSuspensionEnabled) return;
    if (changeInfo.audible === true) {
        untouch(tabId);
    } else if (changeInfo.status === "complete" || changeInfo.audible === false) {
        if (!tab.active && isEligibleForAutoSuspend({ ...tab, audible: false })) {
            if (lastSeen[tabId] === undefined) touch(tabId);
        } else {
            untouch(tabId);
        }
    }
});

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
    untouch(tabId);
    removeSuspendedTabFromStorage(tabId);
    if (activeTabs[removeInfo.windowId] === tabId) {
        delete activeTabs[removeInfo.windowId];
    }
});

browser.runtime.onConnect.addListener((port) => {
    if (port.name === "suspended-tab") {
        debug("Suspended tab connected");
    }
});

// ---- messages ----

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "suspendTab") {
        if (!suspensionEnabled) {
            sendResponse({ success: false, error: "Suspension is disabled" });
            return;
        }
        browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
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
        if (message.url) {
            browser.storage.local.remove(screenshotKeyForUrl(message.url));
            if (sender && sender.tab && sender.tab.id !== undefined) {
                browser.storage.local.remove([`screenshot_${sender.tab.id}`, `favicon_${sender.tab.id}`]);
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
        browser.storage.local.set({ suspensionTimer: totalMinutes });
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
        browser.storage.local.set({ screenshotsEnabled });

    } else if (message.action === "updateIcon") {
        updateIcon(message.active);
    }
});

setInterval(sweepOnce, SWEEP_INTERVAL_MS);
// NOTE: MV2 persistent background can hold this interval. If/when migrating
// to MV3 (service worker), replace with chrome.alarms — workers are killed
// after ~30s and all setTimeout/setInterval state is lost.

// Restore all suspended tabs when the extension is unloaded/reloaded
if (browser.runtime.onSuspend) {
    browser.runtime.onSuspend.addListener(() => {
        browser.tabs.query({}).then((tabs) => {
            tabs.forEach((tab) => {
                if (isSuspendedTabUrl(tab.url)) {
                    const originalUrl = extractOriginalUrl(tab.url);
                    if (originalUrl) browser.tabs.update(tab.id, { url: originalUrl });
                }
            });
        });
    });
}

function restoreClosedSuspendedTabs() {
    const read = suspendedTabsCache !== null
        ? Promise.resolve(suspendedTabsCache)
        : browser.storage.local.get("suspendedTabs").then((d) => (suspendedTabsCache = d.suspendedTabs || {}));
    read.then((suspendedTabs) => {
        if (Object.keys(suspendedTabs).length === 0) {
            cleanupOrphanScreenshots(new Set());
            return;
        }
        browser.tabs.query({}).then((tabs) => {
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
                if (!entry || !entry.url) return;
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
                    for (const closedTab of closedTabs) {
                        try {
                            // Restore as a SUSPENDED page (not the live URL) so
                            // the saved screenshot (keyed by URL hash) still
                            // displays. Screenshot stays until real restore.
                            const suspendedUrl = buildSuspendedUrl(closedTab.url, closedTab.title);
                            let newTab;
                            try {
                                newTab = await browser.tabs.create({ url: suspendedUrl, windowId: closedTab.windowId, active: false });
                            } catch (e) {
                                // windowId gone (window was closed): open in a
                                // current window instead.
                                newTab = await browser.tabs.create({ url: suspendedUrl, active: false });
                            }
                            if (newTab && newTab.id !== undefined) {
                                await addSuspendedTabToStorage(newTab.id, closedTab.url, closedTab.title, newTab.windowId);
                            }
                            await removeSuspendedTabFromStorage(closedTab.tabId);
                        } catch (e) {
                            debug("restore failed:", closedTab.url, e.message);
                        }
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
function cleanupOrphanScreenshots(knownHashes) {
    const collect = () => {
        if (knownHashes) return Promise.resolve(knownHashes);
        return browser.tabs.query({}).then((tabs) => {
            const hashes = new Set();
            tabs.forEach((tab) => {
                if (isSuspendedTabUrl(tab.url)) {
                    const original = extractOriginalUrl(tab.url);
                    if (original) hashes.add(hashString(original));
                }
            });
            const cache = suspendedTabsCache || {};
            Object.values(cache).forEach((entry) => {
                if (entry && entry.url) hashes.add(hashString(entry.url));
            });
            return hashes;
        });
    };
    collect().then((hashes) => {
        browser.storage.local.get(null).then((all) => {
            const orphans = Object.keys(all).filter((k) => {
                if (!k.startsWith("screenshot_")) return false;
                // Legacy numeric keys (screenshot_<tabId>): only kept if some
                // old-format suspended tab still references them; they are
                // migrated on view, otherwise purged here.
                if (/^screenshot_\d+$/.test(k)) return true;
                const hash = k.slice("screenshot_".length);
                return !hashes.has(hash);
            });
            if (orphans.length > 0) {
                debug(`cleaning ${orphans.length} orphan screenshots`);
                browser.storage.local.remove(orphans);
            }
        }).catch((e) => debug("orphan cleanup failed:", e.message));
    }).catch((e) => debug("orphan cleanup failed:", e.message));
}

// Startup
loadInitialState();
setTimeout(restoreClosedSuspendedTabs, 1000);
updateIcon(suspensionEnabled);
