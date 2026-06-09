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
    const screenshotToggle = document.getElementById('screenshotToggle');

    // Load existing toggle state
    browser.storage.local.get(['suspensionEnabled', 'screenshotsEnabled'], function (data) {
        suspensionToggle.checked = data.suspensionEnabled !== false; // default to true
        screenshotToggle.checked = data.screenshotsEnabled !== false; // default to true
        console.log("Loaded suspension enabled state:", suspensionToggle.checked);
        console.log("Loaded screenshots enabled state:", screenshotToggle.checked);
    });

    // Handle toggle change
    suspensionToggle.addEventListener('change', function () {
        const isEnabled = suspensionToggle.checked;
        browser.storage.local.set({ suspensionEnabled: isEnabled }, function () {
            console.log("Suspension enabled state saved:", isEnabled);
            browser.runtime.sendMessage({
                action: "toggleSuspension",
                enabled: isEnabled
            });

            // Update icon based on toggle state
            browser.runtime.sendMessage({
                action: "updateIcon",
                active: isEnabled
            });
        });
    });

    // Handle screenshot toggle change
    screenshotToggle.addEventListener('change', function () {
        const isEnabled = screenshotToggle.checked;
        browser.storage.local.set({ screenshotsEnabled: isEnabled }, function () {
            console.log("Screenshots enabled state saved:", isEnabled);
            browser.runtime.sendMessage({
                action: "toggleScreenshots",
                enabled: isEnabled
            });
        });
    });

    // 2. Replace the timer loading section
    // Load existing timer setting
    browser.storage.local.get('suspensionTimer', function (data) {
        const totalMinutes = data.suspensionTimer || 1;
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        suspensionHoursInput.value = hours;
        suspensionMinutesInput.value = minutes || 1; // Ensure at least 1 minute
    });

    // Save timer setting

    // 3. Replace the timer saving section
    // Save timer setting
    saveTimerButton.addEventListener('click', function () {
        const hoursValue = parseInt(suspensionHoursInput.value, 10) || 0;
        const minutesValue = parseInt(suspensionMinutesInput.value, 10) || 1;

        // Validate inputs
        if (hoursValue < 0 || hoursValue > 23) {
            alert('Hours must be between 0 and 23');
            return;
        }

        if (minutesValue < 1 || minutesValue > 59) {
            alert('Minutes must be between 1 and 59');
            return;
        }

        // Ensure at least 1 minute total
        if (hoursValue === 0 && minutesValue < 1) {
            alert('Total time must be at least 1 minute');
            return;
        }

        const totalMinutes = (hoursValue * 60) + minutesValue;

        browser.storage.local.set({ suspensionTimer: totalMinutes }, function () {
            console.log("Timer saved:", totalMinutes, "minutes");
            browser.runtime.sendMessage({ action: "updateTimer", value: totalMinutes });

            // Add visual feedback
            const originalText = saveTimerButton.textContent;
            saveTimerButton.textContent = "Saved!";
            saveTimerButton.disabled = true;

            setTimeout(() => {
                saveTimerButton.textContent = originalText;
                saveTimerButton.disabled = false;
            }, 2000);
        });
    });


    // 4. Add input validation listeners (optional but recommended)
    suspensionHoursInput.addEventListener('input', function () {
        const value = parseInt(this.value, 10);
        if (value < 0) this.value = 0;
        if (value > 23) this.value = 23;
    });

    suspensionMinutesInput.addEventListener('input', function () {
        const value = parseInt(this.value, 10);
        const hours = parseInt(suspensionHoursInput.value, 10) || 0;

        if (value < 1) this.value = 1;
        if (value > 59) this.value = 59;

        // If hours is 0, ensure minutes is at least 1
        if (hours === 0 && value < 1) {
            this.value = 1;
        }
    });

    // Load existing exceptions
    browser.storage.local.get('exceptions', function (data) {
        const exceptions = data.exceptions || [];
        console.log("Loaded exceptions:", exceptions);
        exceptions.forEach(addExceptionToList);
    });

    addButton.addEventListener('click', function () {
        let domain = domainInput.value.trim();
        if (domain) {
            // Remove protocol if present
            domain = domain.replace(/^(https?:\/\/)?(www\.)?/, '');
            // Remove trailing slash if present
            domain = domain.replace(/\/$/, '');

            browser.storage.local.get('exceptions', function (data) {
                const exceptions = data.exceptions || [];
                if (!exceptions.includes(domain)) {
                    exceptions.push(domain);
                    browser.storage.local.set({ exceptions: exceptions }, function () {
                        console.log("Exception added:", domain);
                        console.log("Updated exceptions:", exceptions);
                        addExceptionToList(domain);
                        domainInput.value = '';
                    });
                }
            });
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
            browser.storage.local.get('exceptions', function (data) {
                const exceptions = data.exceptions || [];
                const index = exceptions.indexOf(domain);
                if (index > -1) {
                    exceptions.splice(index, 1);
                    browser.storage.local.set({ exceptions: exceptions }, function () {
                        console.log("Exception removed:", domain);
                        console.log("Updated exceptions:", exceptions);
                        li.remove();
                    });
                }
            });
        });
        li.appendChild(removeButton);
        exceptionList.appendChild(li);
    }

    // Add event listener for the suspend current tab button
    const suspendCurrentTabButton = document.getElementById('suspendCurrentTab');
    suspendCurrentTabButton.addEventListener('click', () => {
        console.log("Suspend current tab button clicked");
        browser.runtime.sendMessage({ action: "suspendTab" })
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
            browser.runtime.sendMessage({ action: "suspendOtherTabs" })
                .then(response => {
                    console.log("Message sent successfully", response);
                    if (response.success) {
                        console.log(`Suspended ${response.suspended} tabs, skipped ${response.skipped} tabs`);
                    }
                    window.close(); // Close the popup after sending the message
                })
                .catch(error => {
                    console.error("Error sending message:", error);
                });
        });
    }


    // Load visibility state from storage
    browser.storage.local.get('showShortcutInfo', function (data) {
        if (data.showShortcutInfo === false) {
            infoBox.style.display = 'none';
        }
    });

    hideInfoBtn.addEventListener('click', function () {
        infoBox.style.display = 'none';
        browser.storage.local.set({ showShortcutInfo: false }, function () {
            console.log("Shortcut info hidden.");
        });
    });
});

function recoverPendingUrls() {
    browser.storage.local.get(null).then(allData => {
        const pending = Object.entries(allData)
            .filter(([key]) => key.startsWith('pending_suspend_'))
            .map(([key, value]) => ({ key, tabId: key.replace('pending_suspend_', ''), ...value }));

        if (pending.length === 0) return;

        const container = document.getElementById('recovery-container');
        const list = document.getElementById('recovery-list');
        container.style.display = 'block';

        pending.forEach(({ key, tabId, url, title }) => {
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
                browser.tabs.create({ url });
                browser.storage.local.remove(key);
                li.remove();
                if (list.children.length === 0) container.style.display = 'none';
            });

            li.appendChild(label);
            li.appendChild(btn);
            list.appendChild(li);
        });
    });
}