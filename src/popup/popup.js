const extApi = (typeof browser !== "undefined" && browser) || (typeof chrome !== "undefined" && chrome);

function storageGet(keys) {
    try {
        const p = extApi.storage.local.get(keys);
        if (p && typeof p.then === "function") return p;
    } catch (e) { return Promise.reject(e); }
    return new Promise((resolve, reject) => {
        extApi.storage.local.get(keys, (res) => {
            const err = extApi.runtime && extApi.runtime.lastError;
            if (err) reject(new Error(err.message || String(err)));
            else resolve(res);
        });
    });
}

function storageSet(obj) {
    try {
        const p = extApi.storage.local.set(obj);
        if (p && typeof p.then === "function") return p;
    } catch (e) { return Promise.reject(e); }
    return new Promise((resolve, reject) => {
        extApi.storage.local.set(obj, () => {
            const err = extApi.runtime && extApi.runtime.lastError;
            if (err) reject(new Error(err.message || String(err)));
            else resolve();
        });
    });
}

function storageRemove(keys) {
    try {
        const p = extApi.storage.local.remove(keys);
        if (p && typeof p.then === "function") return p;
    } catch (e) { return Promise.reject(e); }
    return new Promise((resolve, reject) => {
        extApi.storage.local.remove(keys, () => {
            const err = extApi.runtime && extApi.runtime.lastError;
            if (err) reject(new Error(err.message || String(err)));
            else resolve();
        });
    });
}

function sendMsg(msg) {
    try {
        const p = extApi.runtime.sendMessage(msg);
        if (p && typeof p.then === "function") return p;
        return Promise.resolve(p);
    } catch (e) { return Promise.reject(e); }
}

function isSafeRestoreUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url);
}

document.addEventListener('DOMContentLoaded', function () {
    recoverPendingUrls();
    const domainInput = document.getElementById('domainInput');
    const addButton = document.getElementById('addDomain');
    const exceptionList = document.getElementById('exceptionList');
    const suspensionHoursInput = document.getElementById('suspensionHours');
    const suspensionMinutesInput = document.getElementById('suspensionMinutes');
    const saveTimerButton = document.getElementById('saveTimer');
    const infoBox = document.getElementById('shortcutInfo');
    const hideInfoBtn = document.getElementById('hideInfoBtn');

    const suspensionToggle = document.getElementById('suspensionToggle');
    const autoSuspensionToggle = document.getElementById('autoSuspensionToggle');
    const screenshotToggle = document.getElementById('screenshotToggle');

    // Load existing toggle state
    storageGet(['suspensionEnabled', 'screenshotsEnabled', 'autoSuspensionEnabled']).then(function (data) {
        data = data || {};
        suspensionToggle.checked = data.suspensionEnabled !== false; // default to true
        screenshotToggle.checked = data.screenshotsEnabled !== false; // default to true
        autoSuspensionToggle.checked = data.autoSuspensionEnabled !== false; // default to true
        console.log("Loaded suspension enabled state:", suspensionToggle.checked);
        console.log("Loaded screenshots enabled state:", screenshotToggle.checked);
        console.log("Loaded auto suspension state:", autoSuspensionToggle.checked);
    }).catch((e) => console.error("load toggles failed:", e));

    // Handle toggle change
    suspensionToggle.addEventListener('change', function () {
        const isEnabled = suspensionToggle.checked;
        storageSet({ suspensionEnabled: isEnabled }).then(function () {
            console.log("Suspension enabled state saved:", isEnabled);
            sendMsg({ action: "toggleSuspension", enabled: isEnabled }).catch(() => {});
            sendMsg({ action: "updateIcon", active: isEnabled }).catch(() => {});
        }).catch((e) => console.error("save suspension failed:", e));
    });

    // Handle auto-suspension toggle change
    autoSuspensionToggle.addEventListener('change', function () {
        const isEnabled = autoSuspensionToggle.checked;
        storageSet({ autoSuspensionEnabled: isEnabled }).then(function () {
            console.log("Auto suspension state saved:", isEnabled);
            sendMsg({ action: "toggleAutoSuspension", enabled: isEnabled }).catch(() => {});
        }).catch((e) => console.error("save auto suspension failed:", e));
    });

    // Handle screenshot toggle change
    screenshotToggle.addEventListener('change', function () {
        const isEnabled = screenshotToggle.checked;
        storageSet({ screenshotsEnabled: isEnabled }).then(function () {
            console.log("Screenshots enabled state saved:", isEnabled);
            sendMsg({ action: "toggleScreenshots", enabled: isEnabled }).catch(() => {});
        }).catch((e) => console.error("save screenshots failed:", e));
    });

    // Load existing timer setting
    storageGet('suspensionTimer').then(function (data) {
        data = data || {};
        const totalMinutes = data.suspensionTimer || 1;
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        suspensionHoursInput.value = hours;
        suspensionMinutesInput.value = minutes;
    }).catch(() => {});

    // Save timer setting
    saveTimerButton.addEventListener('click', function () {
        const hoursValue = parseInt(suspensionHoursInput.value, 10) || 0;
        const minutesValue = parseInt(suspensionMinutesInput.value, 10) || 0;

        // Validate inputs
        if (hoursValue < 0 || hoursValue > 23) {
            alert('Hours must be between 0 and 23');
            return;
        }

        if (minutesValue < 0 || minutesValue > 59) {
            alert('Minutes must be between 0 and 59');
            return;
        }

        // Ensure at least 1 minute total
        if (hoursValue === 0 && minutesValue < 1) {
            alert('Total time must be at least 1 minute');
            return;
        }

        const totalMinutes = (hoursValue * 60) + minutesValue;

        storageSet({ suspensionTimer: totalMinutes }).then(function () {
            console.log("Timer saved:", totalMinutes, "minutes");
            sendMsg({ action: "updateTimer", value: totalMinutes }).catch(() => {});

            // Add visual feedback
            const originalText = saveTimerButton.textContent;
            saveTimerButton.textContent = "Saved!";
            saveTimerButton.disabled = true;

            setTimeout(() => {
                saveTimerButton.textContent = originalText;
                saveTimerButton.disabled = false;
            }, 2000);
        }).catch((e) => console.error("save timer failed:", e));
    });

    // Input validation listeners
    suspensionHoursInput.addEventListener('input', function () {
        const value = parseInt(this.value, 10);
        if (value < 0) this.value = 0;
        if (value > 23) this.value = 23;

        // Adjust minutes if hours changes to 0 and minutes is 0
        const minutes = parseInt(suspensionMinutesInput.value, 10) || 0;
        if (value === 0 && minutes === 0) {
            suspensionMinutesInput.value = 1;
        }
    });

    suspensionMinutesInput.addEventListener('input', function () {
        let value = parseInt(this.value, 10);
        if (isNaN(value) || value < 0) {
            this.value = 0;
            value = 0;
        }
        if (value > 59) this.value = 59;

        const hours = parseInt(suspensionHoursInput.value, 10) || 0;

        // If hours is 0, ensure minutes is at least 1
        if (hours === 0 && value < 1) {
            this.value = 1;
        }
    });

    // Load existing exceptions
    storageGet('exceptions').then(function (data) {
        const exceptions = (data && data.exceptions) || [];
        console.log("Loaded exceptions:", exceptions);
        exceptions.forEach(addExceptionToList);
    }).catch(() => {});

    addButton.addEventListener('click', function () {
        let domain = domainInput.value.trim().toLowerCase();
        if (domain) {
            // Remove protocol if present
            domain = domain.replace(/^(https?:\/\/)?(www\.)?/, '');
            // Remove path and trailing slash if present
            domain = domain.split('/')[0].replace(/\/$/, '');

            storageGet('exceptions').then(function (data) {
                const exceptions = (data && data.exceptions) || [];
                if (!exceptions.includes(domain)) {
                    exceptions.push(domain);
                    return storageSet({ exceptions: exceptions }).then(function () {
                        console.log("Exception added:", domain);
                        addExceptionToList(domain);
                        domainInput.value = '';
                    });
                }
            }).catch((e) => console.error("add exception failed:", e));
        }
    });

    function addExceptionToList(domain) {
        const li = document.createElement('li');
        li.style.fontWeight = 'bold';
        li.textContent = '- ' + domain.charAt(0).toUpperCase() + domain.slice(1);
        const removeButton = document.createElement('button');
        removeButton.textContent = 'X';
        removeButton.style.fontWeight = 'bold';
        removeButton.style.backgroundColor = 'rgb(188, 0, 0)';
        removeButton.addEventListener('click', function () {
            storageGet('exceptions').then(function (data) {
                const exceptions = (data && data.exceptions) || [];
                const index = exceptions.indexOf(domain);
                if (index > -1) {
                    exceptions.splice(index, 1);
                    return storageSet({ exceptions: exceptions }).then(function () {
                        console.log("Exception removed:", domain);
                        li.remove();
                    });
                }
            }).catch((e) => console.error("remove exception failed:", e));
        });
        li.appendChild(removeButton);
        exceptionList.appendChild(li);
    }

    // Add event listener for the suspend current tab button
    const suspendCurrentTabButton = document.getElementById('suspendCurrentTab');
    suspendCurrentTabButton.addEventListener('click', () => {
        console.log("Suspend current tab button clicked");
        sendMsg({ action: "suspendTab" })
            .then(response => {
                console.log("Message sent successfully", response);
                window.close(); // Close the popup after sending the message
            })
            .catch(error => {
                console.error("Error sending message:", error);
            });
    });

    // Add event listener for the suspend other tabs button
    const suspendOtherTabsButton = document.getElementById('suspendOtherTabs');
    if (suspendOtherTabsButton) {
        suspendOtherTabsButton.addEventListener('click', () => {
            console.log("Suspend other tabs button clicked");
            sendMsg({ action: "suspendOtherTabs" })
                .then(response => {
                    console.log("Message sent successfully", response);
                    if (response && response.success) {
                        console.log(`Suspended ${response.suspended} tabs, skipped ${response.skipped} tabs`);
                    }
                    window.close(); // Close the popup after sending the message
                })
                .catch(error => {
                    console.error("Error sending message:", error);
                });
        });
    }


    // Add event listener for the unsuspend other tabs button
    const unsuspendOtherTabsButton = document.getElementById('unsuspendOtherTabs');
    if (unsuspendOtherTabsButton) {
        unsuspendOtherTabsButton.addEventListener('click', () => {
            sendMsg({ action: "unsuspendOtherTabs" })
                .then(response => {
                    if (response && response.success) {
                        console.log(`Restored ${response.restored} tabs, skipped ${response.skipped} tabs`);
                    }
                    window.close(); // Close the popup after sending the message
                })
                .catch(error => {
                    console.error("Error sending message:", error);
                });
        });
    }

    // Load visibility state from storage
    storageGet('showShortcutInfo').then(function (data) {
        if (data && data.showShortcutInfo === false) {
            infoBox.style.display = 'none';
        }
    }).catch(() => {});

    hideInfoBtn.addEventListener('click', function () {
        infoBox.style.display = 'none';
        storageSet({ showShortcutInfo: false }).then(function () {
            console.log("Shortcut info hidden.");
        }).catch(() => {});
    });
});

function recoverPendingUrls() {
    // Reads only the small `pendingSuspends` dict — never get(null), which
    // would load multi-MB screenshots into the popup on every open.
    storageGet('pendingSuspends').then(data => {
        const pending = (data && data.pendingSuspends) || {};
        const entries = Object.entries(pending).filter(([, v]) => v && v.url && isSafeRestoreUrl(v.url));
        if (entries.length === 0) return;

        const container = document.getElementById('recovery-container');
        const list = document.getElementById('recovery-list');
        if (!container || !list) return;
        container.style.display = 'block';

        entries.forEach(([tabId, { url, title }]) => {
            const li = document.createElement('li');
            li.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:var(--secondary); padding:6px 8px; border-radius:4px; margin-bottom:4px;';

            const label = document.createElement('span');
            label.textContent = title || url;
            label.title = url;
            label.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:220px; font-size:12px;';

            const btn = document.createElement('button');
            btn.textContent = 'Restore';
            btn.style.cssText = 'background:rgb(93,24,149); font-size:12px; padding:4px 8px; flex-shrink:0;';
            btn.addEventListener('click', () => {
                if (!isSafeRestoreUrl(url)) return;
                const create = extApi.tabs.create ? extApi.tabs.create({ url }) : null;
                if (create && typeof create.then === "function") create.catch(() => {});
                // Remove from new dict + legacy per-tab key (migration straggler).
                storageGet('pendingSuspends').then(d => {
                    const p = (d && d.pendingSuspends) || {};
                    delete p[tabId];
                    return storageSet({ pendingSuspends: p });
                }).catch(() => {});
                storageRemove(`pending_suspend_${tabId}`).catch(() => {});
                li.remove();
                if (list.children.length === 0) container.style.display = 'none';
            });

            li.appendChild(label);
            li.appendChild(btn);
            list.appendChild(li);
        });
    }).catch(() => {});
}
