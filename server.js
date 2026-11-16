import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile, copyFile } from "node:fs/promises";
import http from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC_FILES = new Set(["index.html", "styles.css", "app.js", "api-config.js", "favicon.svg"]);
const TEMPLATE_ROOT = path.join(ROOT, "android-template");
const DATA_ROOT = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const ARTIFACT_ROOT = path.join(DATA_ROOT, "artifacts");
const JOB_ROOT = path.join(DATA_ROOT, "jobs");
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_CONCURRENT_BUILDS = Math.max(1, Number.parseInt(process.env.MAX_CONCURRENT_BUILDS || "1", 10));
const MAX_QUEUE_SIZE = Math.max(1, Number.parseInt(process.env.MAX_QUEUE_SIZE || "4", 10));
const BUILD_TIMEOUT_MS = 8 * 60 * 1000;
const MAX_BUILD_REQUEST_BYTES = 3 * 1024 * 1024;
const ARTIFACT_TTL_MS = 6 * 60 * 60 * 1000;
const BUILD_COMMAND = process.env.GRADLE_COMMAND || "gradle";
const ALLOWED_CORS_ORIGINS = new Set(
  (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const origin = new URL(value);
      if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== value) {
        throw new Error(`CORS_ORIGINS must contain only exact HTTP(S) origins: ${value}`);
      }
      return origin.origin;
    }),
);
const jobs = new Map();
const queue = [];
const rateLimits = new Map();
let activeBuilds = 0;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
]);

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
}

function sendJson(response, status, data) {
  const payload = Buffer.from(JSON.stringify(data));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

function clientAddress(request) {
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      return forwarded.split(",")[0].trim().slice(0, 64);
    }
  }
  return request.socket.remoteAddress || "unknown";
}

function serverOrigin(request) {
  let protocol = "http:";
  if (process.env.TRUST_PROXY === "1") {
    const forwardedProtocol = request.headers["x-forwarded-proto"];
    if (typeof forwardedProtocol === "string") {
      const candidate = forwardedProtocol.split(",")[0].trim().toLowerCase();
      if (candidate === "http" || candidate === "https") protocol = `${candidate}:`;
    }
  }
  try {
    return request.headers.host ? new URL(`${protocol}//${request.headers.host}`).origin : "";
  } catch {
    return "";
  }
}

function checkRateLimit(request) {
  const now = Date.now();
  const address = clientAddress(request);
  const current = rateLimits.get(address);
  if (!current || current.resetAt <= now) {
    rateLimits.set(address, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return;
  }
  if (current.count >= 8) {
    throw new HttpError(429, "You have reached the hourly build limit. Please try again later.");
  }
  current.count += 1;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BUILD_REQUEST_BYTES) {
        tooLarge = true;
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new HttpError(413, "The build request is too large."));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Enter a website URL and app name to continue."));
      }
    });
    request.on("error", reject);
  });
}

function validateWebsite(rawValue) {
  if (typeof rawValue !== "string" || rawValue.trim().length > 2048) {
    throw new HttpError(400, "Enter a valid HTTPS website address.");
  }
  const raw = rawValue.trim();
  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new HttpError(400, "Enter a valid HTTPS website address.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const labels = hostname.split(".");
  if (
    url.protocol !== "https:" ||
    !hostname.includes(".") ||
    labels.some((label) => !label || label.startsWith("-") || label.endsWith("-")) ||
    /[^a-z0-9.-]/i.test(hostname) ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(hostname) ||
    isIP(hostname) !== 0 ||
    hostname.includes(":") ||
    url.username ||
    url.password
  ) {
    throw new HttpError(400, "Use a public HTTPS website address, such as https://example.com.");
  }
  url.hash = "";
  return url;
}

function validateAppName(rawValue) {
  if (typeof rawValue !== "string") {
    throw new HttpError(400, "Enter a name for your app.");
  }
  const name = rawValue.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  const length = Array.from(name).length;
  if (length < 1 || length > 32) {
    throw new HttpError(400, "App names must be between 1 and 32 characters.");
  }
  return name;
}

const ICON_DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

function validateIconImages(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue) ||
      !rawValue.launcher || !rawValue.foreground || typeof rawValue.launcher !== "object" || typeof rawValue.foreground !== "object") {
    throw new HttpError(400, "The app icon images are not in the expected format. Please choose the icon picture again.");
  }
  const result = { launcher: {}, foreground: {} };
  let totalBytes = 0;
  for (const kind of ["launcher", "foreground"]) {
    for (const [density, dimension] of Object.entries(ICON_DENSITIES)) {
      const value = rawValue[kind][density];
      if (typeof value !== "string" || value.length > 280_000) {
        throw new HttpError(400, "One of the generated icon images is missing or too large.");
      }
      const match = value.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) throw new HttpError(400, "The app icon must contain valid PNG images.");
      const bytes = Buffer.from(match[1], "base64");
      totalBytes += bytes.length;
      if (bytes.length < 24 || totalBytes > 1_500_000 ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          bytes.toString("ascii", 12, 16) !== "IHDR" ||
          bytes.readUInt32BE(16) !== dimension || bytes.readUInt32BE(20) !== dimension) {
        throw new HttpError(400, `The ${density} icon image must be a valid ${dimension} × ${dimension} PNG.`);
      }
      result[kind][density] = bytes;
    }
  }
  return result;
}

function validateFeed(rawValue, enabled) {
  if (!enabled) return "";
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    throw new HttpError(400, "Enter a public Atom or RSS feed address to enable post notifications.");
  }
  return validateWebsite(rawValue).toString();
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function copyTemplate(source, destination, replacements) {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTemplate(sourcePath, destinationPath, replacements);
    } else if (entry.isFile()) {
      let contents = await readFile(sourcePath, "utf8");
      for (const [key, value] of Object.entries(replacements)) {
        contents = contents.replaceAll(`__${key}__`, value);
      }
      await writeFile(destinationPath, contents, "utf8");
    }
  }
}

async function writeCustomIcons(workDirectory, iconImages) {
  if (!iconImages) return;
  const resourceRoot = path.join(workDirectory, "app", "src", "main", "res");
  for (const [density, dimension] of Object.entries(ICON_DENSITIES)) {
    const folder = path.join(resourceRoot, `mipmap-${density}`);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "ic_launcher.png"), iconImages.launcher[density]);
    await writeFile(path.join(folder, "ic_launcher_foreground.png"), iconImages.foreground[density]);
  }
  const adaptive = path.join(resourceRoot, "mipmap-anydpi-v26");
  await mkdir(adaptive, { recursive: true });
  const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/launcher_background"/><foreground android:drawable="@mipmap/ic_launcher_foreground"/></adaptive-icon>\n`;
  await writeFile(path.join(adaptive, "ic_launcher.xml"), adaptiveXml);
  await writeFile(path.join(adaptive, "ic_launcher_round.xml"), adaptiveXml);
  const values = path.join(resourceRoot, "values");
  await mkdir(values, { recursive: true });
  await writeFile(path.join(values, "launcher_colors.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="launcher_background">#6757E8</color></resources>\n`);
}

function safeDownloadName(name) {
  const slug = name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "website-app"}.apk`;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    appName: job.appName,
    message: job.message,
    downloadUrl: job.status === "ready" ? `/api/build/${job.id}/download` : undefined,
    expiresAt: new Date(job.expiresAt).toISOString(),
  };
}

function keepLast(text, addition, maxLength = 12_000) {
  return `${text}${addition}`.slice(-maxLength);
}

async function runBuild(job) {
  job.status = "building";
  job.message = "Building your Android app…";
  let workDirectory;
  let buildLog = "";
  try {
    workDirectory = await mkdtemp(path.join(os.tmpdir(), "web2app-"));
    const hash = createHash("sha256").update(`${job.website}\0${job.appName.toLowerCase()}`).digest("hex").slice(0, 14);
    const replacements = {
      APPLICATION_ID: `com.web2app.site${hash}`,
      APP_NAME_XML: xmlEscape(job.appName),
      START_URL_BASE64: Buffer.from(job.website, "utf8").toString("base64"),
      POST_NOTIFICATIONS_ENABLED: String(job.notifyPosts),
      POSTS_FEED_BASE64: job.notifyPosts ? Buffer.from(job.feedUrl, "utf8").toString("base64") : "",
      ICON_REF: job.iconImages ? "@mipmap/ic_launcher" : "@drawable/ic_launcher",
      ROUND_ICON_REF: job.iconImages ? "@mipmap/ic_launcher_round" : "@drawable/ic_launcher",
    };
    await copyTemplate(TEMPLATE_ROOT, workDirectory, replacements);
    await writeCustomIcons(workDirectory, job.iconImages);
    job.iconImages = null;
    job.feedUrl = "";

    const apkPath = await new Promise((resolve, reject) => {
      let timedOut = false;
      const child = spawn(
        BUILD_COMMAND,
        ["--no-daemon", "--console=plain", "--max-workers=2", "assembleDebug"],
        {
          cwd: workDirectory,
          env: { ...process.env, GRADLE_OPTS: process.env.GRADLE_OPTS || "-Dorg.gradle.daemon=false" },
          shell: process.platform === "win32",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, BUILD_TIMEOUT_MS);
      child.stdout.on("data", (data) => {
        buildLog = keepLast(buildLog, data.toString());
      });
      child.stderr.on("data", (data) => {
        buildLog = keepLast(buildLog, data.toString());
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (timedOut) {
          reject(new Error("The Android build took too long. Try again later."));
        } else if (code !== 0) {
          reject(new Error(`Gradle exited with code ${code}.`));
        } else {
          resolve(path.join(workDirectory, "app", "build", "outputs", "apk", "debug", "app-debug.apk"));
        }
      });
    });

    const apkStat = await stat(apkPath);
    if (!apkStat.isFile() || apkStat.size < 1024 || apkStat.size > 100 * 1024 * 1024) {
      throw new Error("The Android build did not produce a valid APK.");
    }
    await mkdir(ARTIFACT_ROOT, { recursive: true });
    job.apkPath = path.join(ARTIFACT_ROOT, `${job.id}.apk`);
    await copyFile(apkPath, job.apkPath);
    job.apkSize = apkStat.size;
    job.status = "ready";
    job.message = "Your Android app is ready to download.";
    job.expiresAt = Date.now() + ARTIFACT_TTL_MS;
    await persistJob(job);
    console.log(`[build ${job.id}] ready (${apkStat.size} bytes)`);
  } catch (error) {
    job.status = "failed";
    const gradleUnavailable = error?.code === "ENOENT" || /gradle.{0,80}(not recognized|not found|cannot find)|not recognized.{0,80}gradle/i.test(buildLog);
    job.message = gradleUnavailable
      ? "The build service is not configured with Android build tools. Start the included Docker service or configure Java, Gradle, and the Android SDK."
      : error?.message === "The Android build took too long. Try again later."
        ? error.message
        : "The app could not be built. Check the website address and try again.";
    const detail = error?.code ? `${error.code}: ${error.message}` : error?.message || "Unknown build error";
    console.error(`[build ${job.id}] failed: ${detail}`);
    if (buildLog) console.error(buildLog.slice(-4000));
  } finally {
    if (workDirectory) await rm(workDirectory, { recursive: true, force: true }).catch(() => {});
    job.expiresAt = Date.now() + ARTIFACT_TTL_MS;
  }
}

async function persistJob(job) {
  await mkdir(JOB_ROOT, { recursive: true });
  const filePath = path.join(JOB_ROOT, `${job.id}.json`);
  const temporaryPath = `${filePath}.tmp`;
  const saved = {
    id: job.id,
    status: job.status,
    appName: job.appName,
    message: job.message,
    expiresAt: job.expiresAt,
  };
  await writeFile(temporaryPath, JSON.stringify(saved), "utf8");
  await rename(temporaryPath, filePath);
}

async function loadPersistedJobs() {
  await mkdir(ARTIFACT_ROOT, { recursive: true });
  await mkdir(JOB_ROOT, { recursive: true });
  const entries = await readdir(JOB_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(JOB_ROOT, entry.name);
    try {
      const saved = JSON.parse(await readFile(filePath, "utf8"));
      if (!/^[0-9a-f-]{36}$/i.test(saved.id)) {
        await rm(filePath, { force: true });
        continue;
      }
      const apkPath = path.join(ARTIFACT_ROOT, `${saved.id}.apk`);
      if (saved.status !== "ready" || !Number.isFinite(saved.expiresAt) || saved.expiresAt <= Date.now()) {
        await rm(filePath, { force: true });
        if (Number.isFinite(saved.expiresAt) && saved.expiresAt <= Date.now()) {
          await rm(apkPath, { force: true });
        }
        continue;
      }
      await stat(apkPath);
      jobs.set(saved.id, { ...saved, apkPath });
    } catch {
      await rm(filePath, { force: true }).catch(() => {});
    }
  }
}

function pumpQueue() {
  while (activeBuilds < MAX_CONCURRENT_BUILDS && queue.length) {
    const job = queue.shift();
    if (!job || job.status !== "queued") continue;
    activeBuilds += 1;
    runBuild(job).finally(() => {
      activeBuilds -= 1;
      pumpQueue();
    });
  }
}

async function serveStatic(request, response, pathname) {
  const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!STATIC_FILES.has(relativePath)) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }
  const resolved = path.join(ROOT, relativePath);
  let fileStat;
  try {
    fileStat = await stat(resolved);
  } catch {
    sendJson(response, 404, { error: "Not found." });
    return;
  }
  if (!fileStat.isFile()) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }
  const contentType = contentTypes.get(path.extname(resolved).toLowerCase()) || "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": fileStat.size,
    "Cache-Control": "no-cache",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(resolved).pipe(response);
}

async function handleRequest(request, response) {
  setSecurityHeaders(response);
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const { pathname } = requestUrl;

  if (pathname.startsWith("/api/")) {
    const origin = request.headers.origin;
    if (origin) {
      response.setHeader("Vary", "Origin");
      const sameOrigin = origin === serverOrigin(request);
      if (!sameOrigin && !ALLOWED_CORS_ORIGINS.has(origin)) {
        throw new HttpError(403, "This website is not allowed to use the builder API.");
      }
      response.setHeader("Access-Control-Allow-Origin", origin);
      if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type");
        response.setHeader("Access-Control-Max-Age", "86400");
        response.writeHead(204);
        response.end();
        return;
      }
    }
  }

  if (pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, { ok: true, service: "web2app-builder" });
    return;
  }

  if (pathname === "/api/build" && request.method === "POST") {
    checkRateLimit(request);
    const contentType = request.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "Send the build details as JSON.");
    }
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Enter a website URL and app name to continue.");
    }
    const websiteUrl = validateWebsite(body.website);
    const appName = validateAppName(body.appName);
    const notifyPosts = body.notifyPosts === true;
    const feedUrl = validateFeed(body.feedUrl, notifyPosts);
    const iconImages = validateIconImages(body.iconFiles);
    if (queue.length >= MAX_QUEUE_SIZE) {
      throw new HttpError(503, "The build queue is full. Please try again in a few minutes.");
    }

    const job = {
      id: randomUUID(),
      status: "queued",
      appName,
      website: websiteUrl.toString(),
      notifyPosts,
      feedUrl,
      iconImages,
      message: "Your build is queued…",
      createdAt: Date.now(),
      expiresAt: Date.now() + ARTIFACT_TTL_MS,
      apkPath: null,
    };
    jobs.set(job.id, job);
    queue.push(job);
    pumpQueue();
    sendJson(response, 202, publicJob(job));
    return;
  }

  const downloadMatch = pathname.match(/^\/api\/build\/([0-9a-f-]{36})\/download$/i);
  if (downloadMatch && request.method === "GET") {
    const job = jobs.get(downloadMatch[1]);
    if (!job || job.status !== "ready" || !job.apkPath) {
      throw new HttpError(404, "This APK is not available. Its download may have expired.");
    }
    let fileInfo;
    try {
      fileInfo = await stat(job.apkPath);
    } catch {
      throw new HttpError(404, "This APK is not available. Its download may have expired.");
    }
    response.writeHead(200, {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Length": fileInfo.size,
      "Content-Disposition": `attachment; filename="${safeDownloadName(job.appName)}"`,
      "Cache-Control": "private, no-store",
    });
    createReadStream(job.apkPath).pipe(response);
    return;
  }

  const statusMatch = pathname.match(/^\/api\/build\/([0-9a-f-]{36})$/i);
  if (statusMatch && request.method === "GET") {
    const job = jobs.get(statusMatch[1]);
    if (!job) throw new HttpError(404, "This build is not available. Please start a new build.");
    sendJson(response, 200, publicJob(job));
    return;
  }

  if (pathname.startsWith("/api/")) {
    throw new HttpError(404, "Not found.");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new HttpError(405, "This method is not supported.");
  }
  await serveStatic(request, response, pathname);
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof URIError) {
      sendJson(response, 400, { error: "The request URL is not valid." });
      return;
    }
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const message = status === 500 ? "The server could not process this request." : error.message;
    if (status === 500) console.error("[request]", error);
    sendJson(response, status, { error: message });
  });
});

server.requestTimeout = 30_000;
server.headersTimeout = 35_000;
await loadPersistedJobs().catch((error) => console.error("Could not restore previous APK jobs:", error));
server.listen(PORT, HOST, () => {
  console.log(`Web2App Builder listening on http://${HOST}:${PORT}`);
});

const cleanupTimer = setInterval(async () => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expiresAt > now || job.status === "queued" || job.status === "building") continue;
    jobs.delete(id);
    if (job.apkPath) await rm(job.apkPath, { force: true }).catch(() => {});
    await rm(path.join(JOB_ROOT, `${id}.json`), { force: true }).catch(() => {});
  }
  for (const [address, limit] of rateLimits) {
    if (limit.resetAt <= now) rateLimits.delete(address);
  }
}, 10 * 60 * 1000);
cleanupTimer.unref();

process.on("SIGINT", () => {
  clearInterval(cleanupTimer);
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  clearInterval(cleanupTimer);
  server.close(() => process.exit(0));
});
