// GitHub Pages cannot run the APK build server. Its API is hosted separately.
// Keep this hostname in sync with the Render service name in render.yaml.
window.WEB2APP_API_BASE = window.location.hostname.endsWith(".github.io")
  ? "https://web2app-builder-aryabanerjeetick.onrender.com"
  : "";
