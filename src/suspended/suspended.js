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

        if (favicon) {
            document.getElementById('favicon').href = favicon;
        }

        // Legacy tabs embedded the screenshot in the URL itself.
        if (screenshot) {
            document.body.style.backgroundImage = `url(${screenshot})`;
        }

        // Fetch screenshot from storage instead of URL
        if (tabId) {
            browser.storage.local.get([`screenshot_${tabId}`, `favicon_${tabId}`]).then(data => {
                const screenshot = data[`screenshot_${tabId}`];
                const favicon = data[`favicon_${tabId}`];

                if (screenshot) {
                    document.body.style.backgroundImage = `url(${screenshot})`;
                }
                if (favicon) {
                    document.getElementById('favicon').href = favicon;
                }

                browser.storage.local.remove([`screenshot_${tabId}`, `favicon_${tabId}`]);
            });
        }

        document.body.addEventListener('click', () => {
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