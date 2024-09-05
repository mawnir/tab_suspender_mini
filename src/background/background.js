console.log("Tab Suspender extension loaded");

let SUSPEND_DELAY = 60; // default 1 minute
const SUSPENDED_PREFIX = "💤 ";

// Load the suspension timer from storage
browser.storage.local.get('suspensionTimer', function (data) {
    SUSPEND_DELAY = (data.suspensionTimer || 1) * 60; // Convert minutes to seconds
});

browser.tabs.onActivated.addListener(activeInfo => {
    console.log("Tab activated:", activeInfo.tabId);
    resetTimer(activeInfo.tabId);
    // Remove this line: unsuspendTab(activeInfo.tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
        console.log("Tab updated:", tabId);
        resetTimer(tabId);
    }
});

let suspensionTimers = {};

function isExceptionDomain(url) {
    return new Promise((resolve) => {
        if (!url) {
            console.log("Empty URL, not an exception");
            resolve(false);
            return;
        }
        let domain;
        try {
            domain = new URL(url).hostname;
        } catch (error) {
            console.error("Invalid URL:", url);
            resolve(false);
            return;
        }
        browser.storage.local.get('exceptions', function (data) {
            const exceptions = data.exceptions || [];
            console.log("Checking exceptions for:", domain);
            console.log("Current exceptions:", exceptions);
            const isException = exceptions.some(exception => {
                // Remove protocol and www. from both domain and exception
                const cleanDomain = domain.replace(/^www\./, '');
                let cleanException = exception.replace(/^(https?:\/\/)?(www\.)?/, '');
                cleanException = cleanException.replace(/\/$/, ''); // Remove trailing slash if present
                return cleanDomain.includes(cleanException) || cleanException.includes(cleanDomain);
            });
            console.log("Is exception?", isException);
            resolve(isException);
        });
    });
}

function resetTimer(tabId) {
    console.log("Resetting timer for tab:", tabId);
    clearTimeout(suspensionTimers[tabId]);
    browser.tabs.get(tabId).then(tab => {
        if (!tab.url) {
            console.log("Tab has no URL, not setting timer:", tabId);
            return;
        }

        // Check if the tab is already suspended
        if (tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
            // Extract the original URL from the suspended page's parameters
            const suspendedUrl = new URL(tab.url);
            const originalUrl = suspendedUrl.searchParams.get('url');
            if (originalUrl) {
                console.log("Tab is suspended, checking original URL:", originalUrl);
                checkExceptionAndSetTimer(tabId, originalUrl);
            } else {
                console.log("Unable to get original URL for suspended tab:", tabId);
            }
        } else {
            checkExceptionAndSetTimer(tabId, tab.url);
        }
    }).catch(error => {
        console.error("Error getting tab in resetTimer:", tabId, error);
    });
}

function checkExceptionAndSetTimer(tabId, url) {
    isExceptionDomain(url).then(isException => {
        console.log(`Tab ${tabId} exception status:`, isException);
        if (!url.startsWith(browser.runtime.getURL("")) &&
            !url.startsWith("about:") &&
            !url.startsWith("chrome:") &&
            !url.startsWith("moz-extension:") &&
            url !== 'about:blank' &&
            url !== 'about:newtab' &&
            !isException) {
            suspensionTimers[tabId] = setTimeout(() => suspendTab(tabId), SUSPEND_DELAY * 1000);
            console.log(`Timer set for tab ${tabId}`);
        } else {
            console.log("Tab not eligible for suspension timer:", tabId);
        }
    });
}

function suspendTab(tabId) {
    console.log("Attempting to suspend tab:", tabId);
    browser.tabs.get(tabId).then(tab => {
        console.log("Tab info:", tab);
        if (!tab.url) {
            console.log("Tab has no URL, not suspending:", tabId);
            return;
        }

        // Check if the tab is already suspended
        if (tab.url.startsWith(browser.runtime.getURL("src/suspended/suspended.html"))) {
            console.log("Tab is already suspended:", tabId);
            return;
        }

        // Check if the tab is playing audio
        if (tab.audible) {
            console.log("Tab is playing audio, not suspending:", tabId);
            return;
        }

        isExceptionDomain(tab.url).then(isException => {
            console.log(`Tab ${tabId} exception status:`, isException);
            if (tab.url.startsWith(browser.runtime.getURL("")) ||
                tab.url.startsWith("about:") ||
                tab.url.startsWith("chrome:") ||
                tab.url.startsWith("moz-extension:") ||
                tab.url === 'about:blank' ||
                tab.url === 'about:newtab' ||
                isException) {
                console.log("Tab not eligible for suspension:", tabId);
                return;
            }

            console.log("Suspending tab:", tabId);
            console.log("Original title:", tab.title);
            const encodedTitle = encodeURIComponent(tab.title || 'Untitled');
            console.log("Encoded title:", encodedTitle);

            // Capture screenshot of the specific tab
            browser.tabs.captureTab(tabId, { format: 'jpeg', quality: 50 }).then(screenshotUrl => {
                const suspendedUrl = browser.runtime.getURL("src/suspended/suspended.html") +
                    "?url=" + encodeURIComponent(tab.url) +
                    "&title=" + encodedTitle +
                    "&prefix=" + encodeURIComponent(SUSPENDED_PREFIX) +
                    "&favicon=" + encodeURIComponent(tab.favIconUrl || '') +
                    "&screenshot=" + encodeURIComponent(screenshotUrl);

                console.log("Suspended URL:", suspendedUrl);
                browser.tabs.update(tabId, { url: suspendedUrl }).then(() => {
                    console.log("Tab suspended:", tabId);
                }).catch(error => {
                    console.error("Error suspending tab:", tabId, error);
                });
            }).catch(error => {
                console.error("Error capturing screenshot:", error);
                // If screenshot capture fails, suspend the tab without a screenshot
                const suspendedUrl = browser.runtime.getURL("src/suspended/suspended.html") +
                    "?url=" + encodeURIComponent(tab.url) +
                    "&title=" + encodedTitle +
                    "&prefix=" + encodeURIComponent(SUSPENDED_PREFIX) +
                    "&favicon=" + encodeURIComponent(tab.favIconUrl || '');

                browser.tabs.update(tabId, { url: suspendedUrl }).then(() => {
                    console.log("Tab suspended without screenshot:", tabId);
                }).catch(error => {
                    console.error("Error suspending tab:", tabId, error);
                });
            });
        }).catch(error => {
            console.error("Error checking exception domain:", error);
        });
    }).catch(error => {
        console.error("Error getting tab:", tabId, error);
    });
}

// Add this new function to handle messages
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "suspendTab") {
        suspendTab(message.tabId);
    } else if (message.action === "updateTimer") {
        SUSPEND_DELAY = message.value * 60; // Convert minutes to seconds
        console.log("Suspension timer updated:", SUSPEND_DELAY);
        // Reset all existing timers
        Object.keys(suspensionTimers).forEach(tabId => {
            resetTimer(parseInt(tabId, 10));
        });
    }
});

// Modify the setInterval function to include exception checking
setInterval(() => {
    browser.tabs.query({}).then(tabs => {
        console.log("Checking tabs for suspension, total tabs:", tabs.length);
        tabs.forEach(tab => {
            console.log(`Tab ${tab.id}: active=${tab.active}, url=${tab.url}`);

            let urlToCheck = tab.url;
            if (tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
                const suspendedUrl = new URL(tab.url);
                urlToCheck = suspendedUrl.searchParams.get('url') || tab.url;
            }

            isExceptionDomain(urlToCheck).then(isException => {
                if (!tab.active &&
                    !urlToCheck.startsWith(browser.runtime.getURL("")) &&
                    !urlToCheck.startsWith("about:") &&
                    !urlToCheck.startsWith("chrome:") &&
                    !urlToCheck.startsWith("moz-extension:") &&
                    urlToCheck !== 'about:blank' &&
                    urlToCheck !== 'about:newtab' &&
                    !isException) {
                    if (!suspensionTimers[tab.id]) {
                        console.log("Setting new timer for tab:", tab.id);
                        resetTimer(tab.id);
                    } else {
                        console.log("Timer already exists for tab:", tab.id);
                    }
                } else {
                    console.log("Tab not eligible for suspension:", tab.id);
                }
            });
        });
    });
}, 60000); // Check every minute