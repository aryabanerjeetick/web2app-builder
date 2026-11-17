# Web2App Builder

Turn a public HTTPS website into an Android APK from a simple local web page. Add an app name, optionally crop a launcher icon, and optionally enable new-post notifications from a public RSS or Atom feed.

The page is `index.html` in the project root. Keep it alongside `app.js`, `styles.css`, `favicon.svg`, `server.js`, and `android-template/`.

## Start it on Windows

1. Install [Node.js 20 or newer](https://nodejs.org/) and a [Java 17 JDK](https://learn.microsoft.com/en-us/java/openjdk/download).
2. Open PowerShell in this project folder and run:

   ```powershell
   npm run local
   ```

3. On the first run, the setup downloads Gradle and Android command-line build tools into the ignored `.local-tools/` folder. Review and accept the Android SDK licenses when prompted. It then installs the required Android SDK platform and starts the builder.
4. Open [http://localhost:3000](http://localhost:3000) in your browser. Keep the PowerShell window open while building. Press **Ctrl+C** in that window to stop the local server.

The first setup and first APK build can take several minutes. Later runs reuse the downloaded tools. The Gradle archive is checked against Gradle's published SHA-256 checksum. No Android Studio, Docker, paid hosting, or GitHub sign-in is needed.

If you already installed Gradle 8.13 and Android SDK platform/build tools 36.0.0, set `ANDROID_HOME` and start the server with `npm start` instead.

## Features and limits

- Builds Android `.apk` files for public HTTPS websites. The generated app needs an internet connection and the original website must remain online.
- Accepts PNG, JPG, or WebP app icons up to 10 MB. Crop, position, and zoom the picture in the browser; the original picture stays on your device.
- Can check a public Atom or RSS feed for new posts. Blogger feed addresses are suggested automatically. Android may delay background checks, and people must allow notifications on Android 13 and newer.
- Runs the web server and APK builds on your own computer. Keep the computer on and the server window open until the build and download finish.
- The APK is debug-signed for testing and direct installation. It is not publisher-signed for Google Play.
- This project creates Android APKs only. Other operating systems require their own packaging tools and signing; changing the extension does not make an APK work on them.

For iPhone or iPad, open the original website in Safari and choose **Share → Add to Home Screen**.
