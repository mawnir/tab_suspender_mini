// Must stay in sync with background.js copy: URL-hash keys survive window
// close / session restore, tabIds do not.
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

function applyFavicon(href) {
    if (!href) return;
    try {
        let link = document.getElementById('favicon');
        if (!link) return;
        link.href = href;
        // Some browsers only pick up the tab icon if the rel also includes
        // "shortcut icon".
        link.setAttribute('rel', 'icon');
    } catch (e) {
        console.error("Error applying favicon:", e);
    }
}

function parseSuspendedLocation() {
    // New format (2.x): suspended.html#<encTitle>|<encFavicon>|<encPrefix>|<tabId>@<originalUrl>
    const hash = window.location.hash.slice(1);
    if (hash) {
        const atIndex = hash.indexOf('@');
        if (atIndex >= 0) {
            const metaPart = hash.slice(0, atIndex);
            const url = hash.slice(atIndex + 1);
            if (url) {
                const [encodedTitle, encodedFavicon, encodedPrefix, tabId] = metaPart.split('|');
                return {
                    title: decodeURIComponent(encodedTitle || ''),
                    favicon: decodeURIComponent(encodedFavicon || ''),
                    prefix: decodeURIComponent(encodedPrefix || ''),
                    tabId: tabId || '',
                    url,
                    screenshot: ''
                };
            }
        }
    }

    // Legacy format (<=1.51): suspended.html?url=<enc>&title=<enc>&prefix=<enc>&favicon=<enc>&screenshot=<enc>
    // Kept for backward compatibility so tabs suspended before the 2.x
    // hash migration still restore on click instead of showing a blank page.
    try {
        const params = new URLSearchParams(window.location.search);
        const url = params.get('url') ? decodeURIComponent(params.get('url')) : '';
        if (url) {
            return {
                title: decodeURIComponent(params.get('title') || ''),
                favicon: decodeURIComponent(params.get('favicon') || ''),
                prefix: decodeURIComponent(params.get('prefix') || ''),
                tabId: '',
                url,
                screenshot: params.get('screenshot') ? decodeURIComponent(params.get('screenshot')) : ''
            };
        }
    } catch (e) {
        console.error("Error parsing legacy suspended URL:", e);
    }

    return { title: '', favicon: '', prefix: '', tabId: '', url: '', screenshot: '' };
}

function initSuspendedPage() {
    try {
        const { title, favicon, prefix, tabId, url, screenshot } = parseSuspendedLocation();

        document.getElementById('pageTitle').textContent = prefix + title;
        document.getElementById('tabTitle').textContent = title;

        let displayUrl = url;
        try {
            const urlObj = new URL(url);
            displayUrl = urlObj.hostname + (urlObj.pathname === '/' ? '' : urlObj.pathname);
            displayUrl = decodeURIComponent(displayUrl);
            if (displayUrl.length > 60) {
                displayUrl = displayUrl.substring(0, 57) + '...';
            }
        } catch (e) {
            console.error("Error parsing URL for display:", e);
        }

        document.getElementById('url').textContent = displayUrl;
        document.getElementById('url').href = url;

        // Show the original site's icon on the suspended tab immediately if
        // it was embedded in the hash (small http(s) icons), then upgrade
        // from storage below (covers data: URLs + session restores).
        if (favicon) {
            applyFavicon(favicon);
        }

        // Legacy tabs embedded the screenshot in the URL itself.
        if (screenshot) {
            document.body.style.backgroundImage = `url(${screenshot})`;
        }

        // Fetch screenshot from storage instead of URL.
        // Stable URL-hash key first (survives restarts); legacy tabId key as
        // fallback for tabs suspended before the migration. Never delete on
        // view — screenshots persist until real restore, so reloads and
        // session restores keep showing the preview.
        if (url) {
            const stableKey = screenshotKeyForUrl(url);
            const stableFaviconKey = faviconKeyForUrl(url);
            const keys = [stableKey, stableFaviconKey];
            if (tabId) keys.push(`screenshot_${tabId}`, `favicon_${tabId}`);
            browser.storage.local.get(keys).then(data => {
                let storedScreenshot = data[stableKey];
                const storedFavicon = data[stableFaviconKey] ||
                    ((tabId && data[`favicon_${tabId}`]) || undefined);

                // One-time migration: old tabId-keyed screenshot -> stable key
                // so the next restart still finds it.
                if (!storedScreenshot && tabId && data[`screenshot_${tabId}`]) {
                    storedScreenshot = data[`screenshot_${tabId}`];
                    browser.storage.local.set({ [stableKey]: storedScreenshot }).catch(() => {});
                }

                if (storedScreenshot) {
                    document.body.style.backgroundImage = `url(${storedScreenshot})`;
                }
                if (storedFavicon) {
                    applyFavicon(storedFavicon);
                    // One-time migration: old tabId-keyed favicon -> stable key
                    // so the next restart still finds it.
                    if (!data[stableFaviconKey]) {
                        browser.storage.local.set({ [stableFaviconKey]: storedFavicon }).catch(() => {});
                    }
                } else if (!favicon) {
                    // Last-resort fallback so the tab never shows a generic
                    // globe: most sites serve /favicon.ico at the origin.
                    try {
                        applyFavicon(new URL(url).origin + '/favicon.ico');
                    } catch (e) { /* non-http(s) URL, skip */ }
                }
            });
        }

        const notifyRestore = () => {
            // Tell background to drop the screenshot AFTER real restore.
            // Fire-and-forget: navigation must not wait for a response.
            if (!url) return;
            try {
                browser.runtime.sendMessage({ action: "screenshotConsumed", url });
            } catch (e) { /* background may be reloading */ }
        };

        document.getElementById('url').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            notifyRestore();
            window.location.href = url;
        });

        document.body.addEventListener('click', (e) => {
            if (e.target && e.target.closest && e.target.closest('#url')) return;
            notifyRestore();
            window.location.href = url;
        });

        // Detect extension reload/unload to prevent tab from being closed by Firefox/Chrome
        try {
            const port = browser.runtime.connect({ name: "suspended-tab" });
            port.onDisconnect.addListener(() => {
                console.log("Extension disconnected, navigating back to original URL to prevent tab closure");
                window.location.href = url;
            });
        } catch (e) {
            console.error("Failed to connect to background page:", e);
        }

    } catch (error) {
        console.error("Error in suspended.js:", error);
    }
}

document.addEventListener('DOMContentLoaded', initSuspendedPage);