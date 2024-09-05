# Browser Performance Enhancer Extension

This extension improves browser performance by automatically suspending inactive tabs, reducing memory and CPU usage. It offers flexibility with customizable settings and user-defined exceptions.

## Features

### Tab Suspension
- **Automatic Suspension:** Inactive tabs are automatically suspended after a user-defined delay (default: 1 minute). Suspended tabs are replaced with a custom suspension page that stores the original URL and title.
- **Screenshot Capture:** Captures a screenshot of the tab before suspension (where supported).
- **Manual Suspension:** Users can manually suspend tabs at any time for increased control.

### Exception Handling
- **Domain Exceptions:** Maintain a list of domains that will not be suspended. The extension checks URLs against this list before suspending tabs.

### Special Cases
- **Audio Playback Protection:** Tabs playing audio will not be suspended to avoid interruptions.
- **Browser-Specific URLs:** Ignores certain internal browser URLs (e.g., `about:`, `chrome:`, `moz-extension:`) to ensure smooth operation.
