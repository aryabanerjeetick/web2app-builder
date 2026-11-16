# Web2App Builder

A small website with a server-side Android APK build service. Users enter a public HTTPS URL and an app name; the backend builds a signed, installable Android debug APK that opens the website in a WebView. Users do not need Android Studio or Android build tools on their devices.

The form can also accept a PNG, JPG, or WebP launcher picture (up to 10 MB). Users can crop it, drag it into position, and zoom before building. The browser sends only the generated Android icon-size PNGs to the builder; it does not upload the original picture.

New-post alerts are optional. A user can enable them and provide a public Atom or RSS feed; Blogger addresses are suggested automatically for `blogspot.com` sites, and the feed button also prepares a feed URL for custom domains. The generated Android app checks once when first opened and then uses Android WorkManager for periodic checks. Android schedules these checks no more frequently than every 15 minutes and can delay them to save battery. Android 13 and newer also require the user to allow notifications. A private blog or disabled feed cannot provide new-post alerts.

The website entry page is `index.html` in the project root. Its CSS, JavaScript, and favicon are alongside it.

## Run the complete service

The included Docker setup installs Java 17, Gradle, and the Android command-line SDK inside the server container. Install Docker on the machine that will host the builder, then run:

```sh
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). The first image build downloads the Android SDK and takes several minutes. APK builds are then created by the server. Generated APKs are stored in `./data` and automatically removed after six hours.

To run without Docker, install Node.js 20+, Java 17, Gradle 8.13, and Android SDK platform 36/build tools 36.0.0. Set `ANDROID_HOME`, then run `npm start`.

## Deployment

Deploy the Docker image to a server with persistent storage and expose port 3000 through an HTTPS reverse proxy. Keep `/data` on persistent storage. The service limits each source IP to 8 builds per hour, runs one build at a time by default, and expires downloads after six hours. Set `TRUST_PROXY=1` only when a reverse proxy overwrites `X-Forwarded-For` with the real client address. For a public, high-traffic service, add authentication or a managed queue before increasing build capacity.

### Publish the GitHub Pages site with APK builds enabled

GitHub Pages serves the interface but cannot run the Android builder. This repository includes a Render Blueprint for the separate Docker backend. To connect it, use the button below, sign in to Render, review the service, and approve its deployment:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/aryabanerjeetick/web2app-builder)

The configured Render plan is 1 CPU and 2 GB RAM (`1c-2g`), currently listed at **$25/month** on [Render pricing](https://render.com/pricing). Render requires an account and may require a payment method. The blueprint connects this public repository, builds the included Docker image, checks `/api/health`, and permits API calls from this repository's GitHub Pages origin. Once the first deploy is healthy, reload [the published site](https://aryabanerjeetick.github.io/web2app-builder/) and the build button will become available. The GitHub Pages page does not need to move or be rebuilt to use the backend.

The Render service's auto-deploy is off so a new repository commit cannot silently deploy to every Render account that used the public button. To publish backend changes later, review and trigger a deploy in your Render dashboard. APK downloads expire after six hours and can also be lost if the service restarts first.

The generated APK supports Android 6.0 and newer and is signed with Android's debug key. It can be installed directly on Android devices and shared for testing, but it is not signed with a publisher-owned release key for Play Store distribution. A generated app loads its source website over the internet, so the original site must remain available and permit the needed browser features. This builder accepts public HTTPS website URLs.

APK files install on Android only. On an iPhone or iPad, users can open the original website in Safari and choose **Share → Add to Home Screen** instead.

This project generates Android `.apk` files only. It does not generate the other formats listed in the product request: those formats have separate operating-system build tools, packaging rules, code-signing requirements, and in some cases proprietary or store-only distribution steps. Changing an APK's extension does not create a working app for another platform.
