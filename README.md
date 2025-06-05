# Browser Performance Enhancer Extension

This extension improves browser performance by automatically suspending inactive tabs, reducing memory and CPU usage. It offers flexibility with customizable settings and user-defined exceptions.

![screenshot](https://addons.mozilla.org/user-media/previews/full/304/304886.png)

## Features

💡 **Press Ctrl/Command+Shift+X to suspend the current tab instantly.**

---

### Tab Suspension

- **Automatic Suspension:** Inactive tabs are automatically suspended after a user-defined delay (default: 1 minute). Suspended tabs are replaced with a custom suspension page that stores the original URL and title.
- **Manual Suspension:**
  - **Suspend Current Tab:** Instantly suspend the currently active tab.
  - **Suspend All Other Tabs:** Suspend all tabs except the current one.
- **Screenshot Capture:** Captures a screenshot of the tab before suspension (where supported).
- **Suspension Timer Configuration:** Users can set a custom delay in hours and minutes for when tabs should be discarded.

---

### Toggle Options

- **Enable "Tab Suspender Mini":** Lightweight mode for basic suspension functionality.
- **Enable Screenshots:** Toggle screenshot capturing on or off during suspension.

---

### Exception Handling

- **Domain Exceptions:** Maintain a list of domains that will not be suspended. The extension checks URLs against this list before suspending tabs.
- **Easy Domain Management:** Add and manage exception domains directly from the extension popup.

---

### Special Cases

- **Audio Playback Protection:** Tabs playing audio will not be suspended to avoid interruptions.
- **Browser-Specific URLs:** Ignores certain internal browser URLs (e.g., `about:`, `chrome:`, `moz-extension:`) to ensure smooth operation.

