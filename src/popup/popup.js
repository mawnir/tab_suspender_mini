document.addEventListener('DOMContentLoaded', function () {
    const domainInput = document.getElementById('domainInput');
    const addButton = document.getElementById('addDomain');
    const exceptionList = document.getElementById('exceptionList');
    const suspensionTimerInput = document.getElementById('suspensionTimer');
    const saveTimerButton = document.getElementById('saveTimer');

    // Load existing timer setting
    browser.storage.local.get('suspensionTimer', function (data) {
        suspensionTimerInput.value = data.suspensionTimer || 1;
    });

    // Save timer setting
    saveTimerButton.addEventListener('click', function () {
        const timerValue = parseInt(suspensionTimerInput.value, 10);
        if (timerValue > 0) {
            browser.storage.local.set({ suspensionTimer: timerValue }, function () {
                console.log("Timer saved:", timerValue);
                browser.runtime.sendMessage({ action: "updateTimer", value: timerValue });
            });
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
        li.textContent = domain;
        const removeButton = document.createElement('button');
        removeButton.textContent = 'Remove';
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
    suspendCurrentTabButton.addEventListener('click', function () {
        browser.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (tabs[0]) {
                browser.runtime.sendMessage({ action: "suspendTab", tabId: tabs[0].id });
            }
        });
    });
});