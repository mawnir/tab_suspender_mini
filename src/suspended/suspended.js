function initSuspendedPage() {
    try {
        const hash = window.location.hash.slice(1);
        const atIndex = hash.indexOf('@');
        const metaPart = hash.slice(0, atIndex);
        const url = hash.slice(atIndex + 1);

        const [encodedTitle, encodedFavicon, encodedPrefix, tabId] = metaPart.split('|');

        const title = decodeURIComponent(encodedTitle || '');
        const favicon = decodeURIComponent(encodedFavicon || '');
        const prefix = decodeURIComponent(encodedPrefix || '');

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