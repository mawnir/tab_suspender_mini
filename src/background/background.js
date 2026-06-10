console.log("Tab Suspender extension loaded");

let SUSPEND_DELAY = 60; // default 1 minute
const SUSPENDED_PREFIX = "💤 ";
let suspensionTimers = {};
let suspensionEnabled = true; // default to enabled
let screenshotsEnabled = true; // default to enabled

// Load suspension enabled state from storage
function loadSuspensionState() {
    browser.storage.local.get(['suspensionEnabled', 'screenshotsEnabled'], function (data) {
        suspensionEnabled = data.suspensionEnabled !== false; // default to true
        screenshotsEnabled = data.screenshotsEnabled !== false; // default to true
        console.log("Loaded suspension enabled state:", suspensionEnabled);
        console.log("Loaded screenshots enabled state:", screenshotsEnabled);
        updateIcon(suspensionEnabled);
    });
}

// Call this function when the extension starts
loadSuspensionState();

browser.commands.onCommand.addListener((command) => {
    if (command === "suspend-tab" && suspensionEnabled) {
        console.log("Keyboard shortcut triggered: suspend-tab");
        browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
            if (tabs.length > 0) {
                suspendTab(tabs[0].id);
            }
        });
    } else if (command === "suspend-other-tabs" && suspensionEnabled) {
        console.log("Keyboard shortcut triggered: suspend-other-tabs");
        suspendOtherTabs().then(result => {
            console.log(`Suspended ${result.suspended} tabs, skipped ${result.skipped} tabs`);
        }).catch(error => {
            console.error("Error suspending other tabs:", error);
        });
    }
});

browser.contextMenus.create({
    id: "suspend-tab",
    title: "Suspend This Tab",
    contexts: ["all"]
});

browser.contextMenus.create({
    id: "suspend-other-tabs",
    title: "Suspend All Other Tabs",
    contexts: ["all"]
});

browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "suspend-tab" && tab && tab.id && suspensionEnabled) {
        suspendTab(tab.id).catch(error => {
            console.error("Error suspending tab from context menu:", error);
        });
    } else if (info.menuItemId === "suspend-other-tabs" && suspensionEnabled) {
        suspendOtherTabs().catch(error => {
            console.error("Error suspending other tabs from context menu:", error);
        });
    }
});

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

const saveOriginalUrl = (tabId, url, title) => {
    return browser.storage.local.set({
        [`pending_suspend_${tabId}`]: { url, title, savedAt: Date.now() }
    });
};

// Clean up after successful suspension
const clearPendingUrl = (tabId) => {
    browser.storage.local.remove(`pending_suspend_${tabId}`);
};

function suspendOtherTabs() {
    console.log("Suspending all other tabs");

    // Check if suspension is enabled
    if (!suspensionEnabled) {
        console.log("Suspension is disabled, not suspending other tabs");
        return Promise.reject(new Error("Suspension is disabled"));
    }

    return new Promise((resolve, reject) => {
        browser.tabs.query({ currentWindow: true }).then(tabs => {
            console.log("Found tabs in current window:", tabs.length);

            // Get the active tab
            const activeTab = tabs.find(tab => tab.active);
            if (!activeTab) {
                console.log("No active tab found");
                reject(new Error("No active tab found"));
                return;
            }

            console.log("Active tab ID:", activeTab.id);

            // Filter tabs to suspend (exclude active tab)
            const tabsToSuspend = tabs.filter(tab =>
                tab.id !== activeTab.id &&
                !tab.url.startsWith(browser.runtime.getURL("")) &&
                !tab.url.startsWith("about:") &&
                !tab.url.startsWith("chrome:") &&
                !tab.url.startsWith("moz-extension:") &&
                tab.url !== 'about:blank' &&
                tab.url !== 'about:newtab' &&
                !tab.audible // Don't suspend tabs playing audio
            );

            console.log("Tabs to suspend:", tabsToSuspend.length);

            if (tabsToSuspend.length === 0) {
                console.log("No eligible tabs to suspend");
                resolve({ suspended: 0, skipped: tabs.length - 1 });
                return;
            }

            let suspendedCount = 0;
            let skippedCount = 0;
            let processedCount = 0;

            // Function to check if all tabs have been processed
            const checkComplete = () => {
                if (processedCount === tabsToSuspend.length) {
                    console.log(`Suspension complete. Suspended: ${suspendedCount}, Skipped: ${skippedCount}`);
                    resolve({ suspended: suspendedCount, skipped: skippedCount });
                }
            };

            // Process each tab
            tabsToSuspend.forEach(tab => {
                // Check if tab is in exception list
                isExceptionDomain(tab.url).then(isException => {
                    processedCount++;

                    if (isException) {
                        console.log(`Tab ${tab.id} is in exception list, skipping`);
                        skippedCount++;
                        checkComplete();
                        return;
                    }

                    // Clear any existing timer for this tab
                    clearTimeout(suspensionTimers[tab.id]);
                    delete suspensionTimers[tab.id];

                    // Suspend the tab
                    suspendTab(tab.id).then(() => {
                        console.log(`Successfully suspended tab ${tab.id}`);
                        suspendedCount++;
                        checkComplete();
                    }).catch(error => {
                        console.error(`Failed to suspend tab ${tab.id}:`, error);
                        skippedCount++;
                        checkComplete();
                    });
                }).catch(error => {
                    console.error(`Error checking exception for tab ${tab.id}:`, error);
                    processedCount++;
                    skippedCount++;
                    checkComplete();
                });
            });

        }).catch(error => {
            console.error("Error querying tabs:", error);
            reject(error);
        });
    });
}

function suspendTab(tabId) {
    console.log("Entering suspendTab function for tabId:", tabId);

    // Check if suspension is enabled
    if (!suspensionEnabled) {
        console.log("Suspension is disabled, not suspending tab:", tabId);
        return Promise.reject(new Error("Suspension is disabled"));
    }

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

                // Function to create suspended URL
                const createSuspendedUrl = async (screenshotUrl = '') => {
                    const base = browser.runtime.getURL("src/suspended/suspended.html");

                    if (screenshotUrl) {
                        await browser.storage.local.set({ [`screenshot_${tabId}`]: screenshotUrl });
                    }

                    const meta = [
                        encodeURIComponent(tab.title || ''),
                        '',
                        encodeURIComponent(SUSPENDED_PREFIX),
                        tabId
                    ].join('|');

                    return `${base}#${meta}@${tab.url}`;
                };

                // Function to update tab with suspended URL
                const updateTabToSuspended = async (screenshotUrl) => {
                    const suspendedUrl = await createSuspendedUrl(screenshotUrl);

                    saveOriginalUrl(tabId, tab.url, tab.title).then(() => {
                        browser.tabs.update(tabId, { url: suspendedUrl }).then(() => {
                            console.log("Tab successfully suspended:", tabId);
                            updateIcon(true);
                            clearPendingUrl(tabId);
                            resolve();
                        }).catch(error => {
                            console.error("Error updating tab:", tabId, error);
                            clearPendingUrl(tabId);
                            reject(error);
                        });
                    });
                };

                // Capture screenshot if enabled, otherwise suspend without screenshot
                if (screenshotsEnabled) {
                    console.log("Attempting to capture screenshot for tab:", tabId);
                    browser.tabs.captureTab(tabId, { format: 'jpeg', quality: 50 }).then(screenshotUrl => {
                        console.log("Screenshot captured for tab:", tabId);
                        updateTabToSuspended(screenshotUrl);
                    }).catch(error => {
                        console.error("Error capturing screenshot:", error);
                        // If screenshot capture fails, suspend the tab without a screenshot
                        updateTabToSuspended();
                    });
                } else {
                    console.log("Screenshots disabled, suspending without screenshot:", tabId);
                    updateTabToSuspended();
                }
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

    if (!suspensionEnabled) {
        console.log("Suspension is disabled, not setting timer for tab:", tabId);
        return;
    }

    browser.tabs.get(tabId).then(tab => {
        if (!tab.url) {
            console.log("Tab has no URL, not setting timer:", tabId);
            return;
        }

        const isSuspendedTab = tab.url.startsWith(browser.runtime.getURL("src/suspended/suspended.html"));

        // For suspended tabs, we need to extract original URL
        const effectiveUrl = isSuspendedTab ? tab.url.slice(tab.url.indexOf('@') + 1) : tab.url;

        isExceptionDomain(effectiveUrl).then(isException => {
            if (!tab.url.startsWith(browser.runtime.getURL("")) &&
                !tab.url.startsWith("about:") &&
                !tab.url.startsWith("chrome:") &&
                !tab.url.startsWith("moz-extension:") &&
                tab.url !== 'about:blank' &&
                tab.url !== 'about:newtab' &&
                !tab.audible &&
                !isException) {

                suspensionTimers[tabId] = setTimeout(() => {
                    browser.tabs.get(tabId).then(latestTab => {
                        // FINAL GUARD — check if still active
                        if (latestTab.active) {
                            console.log("Tab is still active at timeout, skipping suspension:", tabId);
                            return;
                        }
                        suspendTab(tabId);
                    });
                }, SUSPEND_DELAY * 1000);

                console.log(`Timer set for tab ${tabId}`);
            } else {
                console.log("Tab not eligible for suspension timer:", tabId);
            }
        });
    }).catch(error => {
        console.error("Error in resetTimer:", error);
    });
}


function checkExceptionAndSetTimer(tabId, url) {
    // Don't set timers if suspension is disabled
    if (!suspensionEnabled) {
        console.log("Suspension is disabled, not setting timer for tab:", tabId);
        return;
    }

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
        const totalMinutes = data.suspensionTimer || 1;
        SUSPEND_DELAY = totalMinutes * 60; // Convert minutes to seconds
        console.log("Loaded suspension timer:", totalMinutes, "minutes (", SUSPEND_DELAY, "seconds)");
    });
}

// Clear all suspension timers
function clearAllTimers() {
    console.log("Clearing all suspension timers");
    Object.keys(suspensionTimers).forEach(tabId => {
        clearTimeout(suspensionTimers[tabId]);
        delete suspensionTimers[tabId];
    });
}

// Call this function when the extension starts
loadSuspensionTimer();

// Event listeners
browser.tabs.onActivated.addListener(activeInfo => {
    console.log("Tab activated:", activeInfo.tabId);
    if (suspensionEnabled) {
        resetTimer(activeInfo.tabId);
    }
    // Clear timer for the activated tab
    clearTimeout(suspensionTimers[activeInfo.tabId]);
    delete suspensionTimers[activeInfo.tabId];
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && suspensionEnabled) {
        console.log("Tab updated:", tabId);
        resetTimer(tabId);
    }
});

// Message listener
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Received message:", message);

    if (message.action === "suspendTab") {
        if (!suspensionEnabled) {
            console.log("Suspension is disabled, cannot suspend tab");
            sendResponse({ success: false, error: "Suspension is disabled" });
            return;
        }

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

    } else if (message.action === "suspendOtherTabs") {
        if (!suspensionEnabled) {
            console.log("Suspension is disabled, cannot suspend other tabs");
            sendResponse({ success: false, error: "Suspension is disabled" });
            return;
        }

        console.log("Suspending all other tabs");
        suspendOtherTabs()
            .then(result => {
                console.log("Other tabs suspension completed successfully");
                sendResponse({
                    success: true,
                    suspended: result.suspended,
                    skipped: result.skipped
                });
            })
            .catch(error => {
                console.error("Error during other tabs suspension:", error);
                sendResponse({ success: false, error: error.message });
            });
        return true; // Indicates that we will send a response asynchronously

    } else if (message.action === "updateTimer") {
        const totalMinutes = message.value;
        SUSPEND_DELAY = totalMinutes * 60; // Convert minutes to seconds
        console.log("Suspension timer updated:", totalMinutes, "minutes (", SUSPEND_DELAY, "seconds)");

        // Save the new timer value to storage
        browser.storage.local.set({ suspensionTimer: totalMinutes }, function () {
            console.log("Timer saved to storage:", totalMinutes, "minutes");
        });

        // Reset all existing timers if suspension is enabled
        if (suspensionEnabled) {
            Object.keys(suspensionTimers).forEach(tabId => {
                resetTimer(parseInt(tabId, 10));
            });
        }
    } else if (message.action === "toggleSuspension") {
        suspensionEnabled = message.enabled;
        console.log("Suspension toggled:", suspensionEnabled);

        if (!suspensionEnabled) {
            // Clear all existing timers when disabling
            clearAllTimers();
        } else {
            // Restart timers for all tabs when enabling
            browser.tabs.query({}).then(tabs => {
                tabs.forEach(tab => {
                    if (!tab.active && !tab.audible) {
                        resetTimer(tab.id);
                    }
                });
            });
        }

        // Update icon based on toggle state
        updateIcon(suspensionEnabled);

    } else if (message.action === "toggleScreenshots") {
        screenshotsEnabled = message.enabled;
        console.log("Screenshots toggled:", screenshotsEnabled);

        // Save the new screenshot setting to storage
        browser.storage.local.set({ screenshotsEnabled: screenshotsEnabled }, function () {
            console.log("Screenshots setting saved to storage:", screenshotsEnabled);
        });

    } else if (message.action === "updateIcon") {
        updateIcon(message.active);
    }
});

// Interval for checking tabs
setInterval(() => {
    // Only check tabs if suspension is enabled
    if (!suspensionEnabled) {
        return;
    }

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

// Initialize icon based on suspension state
updateIcon(suspensionEnabled);