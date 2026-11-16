FROM node:22-bookworm-slim

ARG ANDROID_CMDLINE_TOOLS_VERSION=15859902
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH="/opt/gradle/gradle-8.13/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:${PATH}"
ENV PORT=3000
ENV DATA_DIR=/data

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl openjdk-17-jdk-headless unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://services.gradle.org/distributions/gradle-8.13-bin.zip -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt/gradle \
    && rm /tmp/gradle.zip \
    && mkdir -p "${ANDROID_HOME}/cmdline-tools" /tmp/android-tools \
    && curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS_VERSION}_latest.zip" -o /tmp/android-tools.zip \
    && unzip -q /tmp/android-tools.zip -d /tmp/android-tools \
    && mv /tmp/android-tools/cmdline-tools "${ANDROID_HOME}/cmdline-tools/latest" \
    && rm -rf /tmp/android-tools /tmp/android-tools.zip \
    && yes | sdkmanager --licenses >/dev/null \
    && sdkmanager "platform-tools" "platforms;android-36" "build-tools;35.0.0" "build-tools;36.0.0" \
    && mkdir -p /data \
    && chown -R node:node /data /home/node /opt/gradle

WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node index.html styles.css app.js api-config.js favicon.svg ./
COPY --chown=node:node android-template ./android-template

USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server.js"]
