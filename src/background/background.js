console.log("Tab Suspender extension loaded");

let SUSPEND_DELAY = 60; // default 1 minute
const SUSPENDED_PREFIX = "💤 ";
let suspensionTimers = {};

// Function definitions
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

function updateIcon(active) {
    const path = active ? "icons/icon_active.png" : "icons/icon_inactive.png";
    browser.browserAction.setIcon({ path });
}

function suspendTab(tabId) {
    console.log("Entering suspendTab function for tabId:", tabId);
    return new Promise((resolve, reject) => {
        browser.tabs.get(tabId).then(tab => {
            console.log("Retrieved tab info:", tab);
            if (!tab.url) {
                console.log("Tab has no URL, not suspending:", tabId);
                reject(new Error("Tab has no URL"));
                return;
            }

            console.log("Checking if tab is exception:", tab.url);
            isExceptionDomain(tab.url).then(isException => {
                console.log(`Tab ${tabId} exception status:`, isException);
                if (tab.url.startsWith(browser.runtime.getURL("")) ||
                    tab.url.startsWith("about:") ||
                    tab.url.startsWith("chrome:") ||
                    tab.url.startsWith("moz-extension:") ||
                    tab.url === 'about:blank' ||
                    tab.url === 'about:newtab' ||
                    tab.audible || // Add exception for tabs playing audio
                    isException) {
                    console.log("Tab not eligible for suspension:", tabId);
                    reject(new Error("Tab not eligible for suspension"));
                    return;
                }

                console.log("Proceeding with tab suspension:", tabId);
                const encodedTitle = encodeURIComponent(tab.title || 'Untitled');
                console.log("Encoded title:", encodedTitle);

                console.log("Attempting to capture screenshot for tab:", tabId);
                browser.tabs.captureTab(tabId, { format: 'jpeg', quality: 50 }).then(screenshotUrl => {
                    console.log("Screenshot captured for tab:", tabId);
                    const suspendedUrl = browser.runtime.getURL("src/suspended/suspended.html") +
                        "?url=" + encodeURIComponent(tab.url) +
                        "&title=" + encodedTitle +
                        "&prefix=" + encodeURIComponent(SUSPENDED_PREFIX) +
                        "&favicon=" + encodeURIComponent(tab.favIconUrl || '') +
                        "&screenshot=" + encodeURIComponent(screenshotUrl);

                    console.log("Suspended URL:", suspendedUrl);
                    browser.tabs.update(tabId, { url: suspendedUrl }).then(() => {
                        console.log("Tab successfully suspended:", tabId);
                        updateIcon(true);
                        resolve();
                    }).catch(error => {
                        console.error("Error updating tab:", tabId, error);
                        reject(error);
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
                        updateIcon(true);
                        resolve();
                    }).catch(error => {
                        console.error("Error updating tab without screenshot:", tabId, error);
                        reject(error);
                    });
                });
            }).catch(error => {
                console.error("Error checking exception domain:", error);
                reject(error);
            });
        }).catch(error => {
            console.error("Error getting tab:", tabId, error);
            reject(error);
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
        browser.tabs.get(tabId).then(tab => {
            if (!url.startsWith(browser.runtime.getURL("")) &&
                !url.startsWith("about:") &&
                !url.startsWith("chrome:") &&
                !url.startsWith("moz-extension:") &&
                url !== 'about:blank' &&
                url !== 'about:newtab' &&
                !tab.audible && // Add check for audio playing
                !isException) {
                suspensionTimers[tabId] = setTimeout(() => suspendTab(tabId), SUSPEND_DELAY * 1000);
                console.log(`Timer set for tab ${tabId}`);
            } else {
                console.log("Tab not eligible for suspension timer:", tabId);
            }
        }).catch(error => {
            console.error("Error getting tab in checkExceptionAndSetTimer:", tabId, error);
        });
    });
}

// Load the suspension timer from storage
function loadSuspensionTimer() {
    browser.storage.local.get('suspensionTimer', function (data) {
        SUSPEND_DELAY = (data.suspensionTimer || 1) * 60; // Convert minutes to seconds
        console.log("Loaded suspension timer:", SUSPEND_DELAY);
    });
}

// Call this function when the extension starts
loadSuspensionTimer();

// Event listeners
browser.tabs.onActivated.addListener(activeInfo => {
    console.log("Tab activated:", activeInfo.tabId);
    resetTimer(activeInfo.tabId);
    // Clear timer for the activated tab
    clearTimeout(suspensionTimers[activeInfo.tabId]);
    delete suspensionTimers[activeInfo.tabId];
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
        console.log("Tab updated:", tabId);
        resetTimer(tabId);
    }
});

// Message listener
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Received message:", message);
    if (message.action === "suspendTab") {
        console.log("Suspending current tab");
        browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
            if (tabs.length > 0) {
                console.log("Found active tab:", tabs[0].id);
                suspendTab(tabs[0].id)
                    .then(() => {
                        console.log("Tab suspension completed successfully");
                        sendResponse({ success: true });
                    })
                    .catch(error => {
                        console.error("Error during tab suspension:", error);
                        sendResponse({ success: false, error: error.message });
                    });
            } else {
                console.log("No active tab found");
                sendResponse({ success: false, error: "No active tab found" });
            }
        }).catch(error => {
            console.error("Error querying tabs:", error);
            sendResponse({ success: false, error: error.message });
        });
        return true; // Indicates that we will send a response asynchronously
    } else if (message.action === "updateTimer") {
        SUSPEND_DELAY = message.value * 60; // Convert minutes to seconds
        console.log("Suspension timer updated:", SUSPEND_DELAY);
        // Save the new timer value to storage
        browser.storage.local.set({ suspensionTimer: message.value }, function () {
            console.log("Timer saved to storage:", message.value);
        });
        // Reset all existing timers
        Object.keys(suspensionTimers).forEach(tabId => {
            resetTimer(parseInt(tabId, 10));
        });
    }
});

// Interval for checking tabs
setInterval(() => {
    browser.tabs.query({}).then(tabs => {
        console.log("Checking tabs for suspension, total tabs:", tabs.length);
        tabs.forEach(tab => {
            console.log(`Tab ${tab.id}: active=${tab.active}, audible=${tab.audible}, url=${tab.url}`);

            // If the tab is active or playing audio, clear its timer and skip
            if (tab.active || tab.audible) {
                clearTimeout(suspensionTimers[tab.id]);
                delete suspensionTimers[tab.id];
                console.log("Tab is active or playing audio, skipping:", tab.id);
                return;
            }

            isExceptionDomain(tab.url).then(isException => {
                if (!tab.active &&
                    !tab.audible && // Add check for audio playing
                    !tab.url.startsWith(browser.runtime.getURL("")) &&
                    !tab.url.startsWith("about:") &&
                    !tab.url.startsWith("chrome:") &&
                    !tab.url.startsWith("moz-extension:") &&
                    tab.url !== 'about:blank' &&
                    tab.url !== 'about:newtab' &&
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

// Initialize icon
updateIcon(false);  // Set to inactive by default