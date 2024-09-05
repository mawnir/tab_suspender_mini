function initSuspendedPage() {
    try {
        const params = new URLSearchParams(window.location.search);
        const title = decodeURIComponent(params.get('title') || '');
        const url = decodeURIComponent(params.get('url') || '');
        const prefix = decodeURIComponent(params.get('prefix') || '');
        const favicon = decodeURIComponent(params.get('favicon') || '');
        const screenshot = decodeURIComponent(params.get('screenshot') || '');

        document.getElementById('pageTitle').textContent = prefix + title;
        document.getElementById('tabTitle').textContent = title;
        document.getElementById('url').textContent = url;
        document.getElementById('url').href = url;

        // Set the favicon
        if (favicon) {
            document.getElementById('favicon').href = favicon;
        }

        // Set the background image
        if (screenshot) {
            document.body.style.backgroundImage = `url(${screenshot})`;
        }

        // Add click event to reload the original page
        document.body.addEventListener('click', () => {
            window.location.href = url;
        });
    } catch (error) {
        console.error("Error in suspended.js script:", error);
    }
}

document.addEventListener('DOMContentLoaded', initSuspendedPage);