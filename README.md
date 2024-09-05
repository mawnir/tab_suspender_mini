The extension aims to improve browser performance by suspending inactive tabs while providing flexibility through user-defined exceptions and settings.
Here's a summary of its main functions:
--> Tab Suspension: Automatically suspends inactive tabs after a set delay (default 1 minute).
Suspended tabs are replaced with a custom suspended page, storing the original URL and title.
--> Captures a screenshot of the tab before suspending (if possible).
--> Exception Handling: Maintains a list of exception domains that won't be suspended.
Checks URLs against this list before suspending.
--> User Interaction: Allows manual suspension of tabs.
Special Cases: Doesn't suspend tabs playing audio.
Ignores certain browser-specific URLs (e.g., about:, chrome:, moz-extension:).
