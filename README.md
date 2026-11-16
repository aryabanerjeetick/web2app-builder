# Web2App Builder

Turn a public HTTPS website into an Android APK from a simple web form. Users can add an app name, upload and crop a launcher icon, and optionally turn on new-post notifications from a public RSS or Atom feed. No Android Studio or paid build server is needed.

The main page is `index.html` in the project root. Keep it beside `app.js`, `styles.css`, and `favicon.svg` when uploading the project.

## Free GitHub Pages setup

1. Create a **public** GitHub repository and upload all project files with `index.html` at the repository root.
2. Make sure the repository's **Issues** and **Actions** features are enabled.
3. In **Settings → Pages**, publish the `main` branch from the repository root.
4. Wait for GitHub Pages to finish its first deployment, then open the Pages link.

The page detects its repository from the standard `owner.github.io/repository` address, so it works when deployed from a copy or fork. For a custom domain, set `window.WEB2APP_GITHUB_REPOSITORY` to `"owner/repository"` in `index.html` before `app.js` loads.

The **Build** button opens a pre-filled public GitHub issue. A free GitHub sign-in is required to submit the request and download the APK. Build issues remain visible publicly: the website address, app name, optional feed address, and any icon package attached to the issue can be seen by anyone. Do not submit private website or feed details. If an icon was selected, attach the downloaded `web2app-icons.txt` file before submitting the issue.

GitHub Actions builds the APK on a standard hosted runner. The free queue allows three requests per GitHub account every 24 hours. The APK download link is posted to the issue and expires after one day. If a build fails, open its Actions run from the issue comment for details.

## What the generated APK does

The APK opens the original website in an Android WebView and supports Android 6.0 and newer. Website forms, downloads, camera, microphone, and location features are supported where the website and Android device permit them. Websites must be public, use HTTPS, and stay online for the app to work.

The APK is signed with Android's debug key. It can be installed and shared for testing, but it is not publisher-signed for Google Play. This builder creates **Android `.apk` files only**. It does not make iPhone, Windows, macOS, Linux, console, or other platform packages; those need different platform tools and signing.

For iPhone and iPad, use Safari's **Share → Add to Home Screen** on the original website.

## Private local builds

To keep build requests private, run the included Docker service on a computer you control. Install Docker, then run:

```sh
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). The first build downloads Android build tools and can take several minutes. The local server keeps APKs for six hours. Node.js 20+, Java 17, Gradle 8.13, and Android SDK platform/build tools 36.0.0 are needed if running without Docker; start it with `npm start`.

Run the offline request queue checks with:

```sh
npm test
```
