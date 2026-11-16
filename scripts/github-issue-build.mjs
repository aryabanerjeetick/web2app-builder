import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MARKER = "<!-- WEB2APP_BUILD_REQUEST -->";
const ISSUE_LIMIT_PER_DAY = 3;
const ISSUE_WINDOW_MS = 24 * 60 * 60 * 1000;

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment value: ${name}`);
  return value;
}

function issueNumber() {
  const value = Number.parseInt(env("ISSUE_NUMBER"), 10);
  if (!Number.isInteger(value) || value < 1) throw new Error("The issue number is invalid.");
  return value;
}

function githubBase() {
  return (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
}

async function githubRequest(apiPath, options = {}) {
  const response = await fetch(`${githubBase()}${apiPath}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let result = null;
  if (text) {
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error("GitHub returned an unreadable response.");
    }
  }
  if (!response.ok) throw new Error(`GitHub request failed with status ${response.status}.`);
  return result;
}

async function addIssueComment(message) {
  const repository = env("GITHUB_REPOSITORY");
  const number = issueNumber();
  await githubRequest(`/repos/${repository}/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: message }),
  });
}

function field(body, label) {
  const line = body.split(/\r?\n/).find((item) => item.startsWith(`${label}:`));
  return line ? line.slice(label.length + 1).trim() : "";
}

function parseIssueBody(body) {
  if (typeof body !== "string" || body.length > 20_000 || !body.includes(MARKER)) {
    throw new Error("This is not a valid Web2App build request.");
  }
  const website = field(body, "Website URL");
  const appName = field(body, "App name").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const notificationValue = field(body, "New post notifications").toLowerCase();
  const feedValue = field(body, "Feed URL");
  const iconValue = field(body, "Icon package").toLowerCase();

  let websiteUrl;
  try {
    websiteUrl = new URL(website);
  } catch {
    throw new Error("Enter a valid public HTTPS website address in the builder.");
  }
  if (websiteUrl.protocol !== "https:" || !websiteUrl.hostname.includes(".")) {
    throw new Error("Enter a valid public HTTPS website address in the builder.");
  }
  if (!appName || Array.from(appName).length > 32) {
    throw new Error("App names must be between 1 and 32 characters.");
  }
  if (!["yes", "no"].includes(notificationValue)) {
    throw new Error("The notification choice is missing. Open a new request from the builder.");
  }
  const notifyPosts = notificationValue === "yes";
  if (notifyPosts && !feedValue) {
    throw new Error("Enter a public Atom or RSS feed address in the builder.");
  }
  const iconRequested = iconValue.startsWith("attach ");
  return {
    website: websiteUrl.toString(),
    appName,
    notifyPosts,
    feedUrl: notifyPosts ? feedValue : "",
    iconUrl: iconRequested ? attachmentUrl(body) : "",
    iconRequested,
  };
}

function attachmentUrl(body) {
  const candidate = body.match(/https:\/\/github\.com\/user-attachments\/files\/[A-Za-z0-9._/-]+/i)?.[0];
  if (!candidate) throw new Error("Attach the downloaded web2app-icons.txt file to the issue before submitting it.");
  const parsed = new URL(candidate.replace(/[.,;]+$/, ""));
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || !parsed.pathname.startsWith("/user-attachments/files/")) {
    throw new Error("The icon attachment must be a GitHub issue file upload.");
  }
  return parsed.toString();
}

async function readIconPackage(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("The icon attachment could not be downloaded. Attach the JSON icon package again.");
  const finalHost = new URL(response.url).hostname;
  const isGitHubAssetHost = finalHost === "github.com" ||
    finalHost.endsWith(".githubusercontent.com") ||
    finalHost === "objects.githubusercontent.com" ||
    /^github-production-user-asset-[a-z0-9-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(finalHost);
  if (!isGitHubAssetHost) {
    throw new Error("The icon attachment redirected to an unexpected host.");
  }
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > 2_500_000) throw new Error("The icon package is too large. Choose a smaller picture.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 2_500_000) throw new Error("The icon package is empty or too large.");
  let iconFiles;
  try {
    iconFiles = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("The icon upload is not a valid Web2App icon package.");
  }
  if (!iconFiles || typeof iconFiles !== "object" || Array.isArray(iconFiles)) {
    throw new Error("The icon upload is not a valid Web2App icon package.");
  }
  return iconFiles;
}

async function enforceAccountLimit(author) {
  const repository = env("GITHUB_REPOSITORY");
  const query = new URLSearchParams({
    creator: author,
    state: "all",
    per_page: "100",
    sort: "created",
    direction: "desc",
  });
  const issues = await githubRequest(`/repos/${repository}/issues?${query.toString()}`);
  const cutoff = Date.now() - ISSUE_WINDOW_MS;
  const recentRequests = (Array.isArray(issues) ? issues : []).filter((item) => {
    if (item.pull_request || !item.body?.includes(MARKER)) return false;
    return Number.isFinite(Date.parse(item.created_at)) && Date.parse(item.created_at) >= cutoff;
  }).length;
  if (recentRequests > ISSUE_LIMIT_PER_DAY) {
    throw new Error(`This free queue allows ${ISSUE_LIMIT_PER_DAY} builds per GitHub account every 24 hours. Try again later.`);
  }
}

async function setOutput(name, value) {
  const outputFile = env("GITHUB_OUTPUT");
  await appendFile(outputFile, `${name}=${value}\n`, "utf8");
}

async function prepare() {
  try {
    const body = env("ISSUE_BODY");
    const request = parseIssueBody(body);
    await enforceAccountLimit(env("ISSUE_AUTHOR"));
    let iconFiles = null;
    if (request.iconRequested) iconFiles = await readIconPackage(request.iconUrl);
    const requestFile = env("REQUEST_FILE");
    await mkdir(path.dirname(requestFile), { recursive: true });
    await writeFile(requestFile, JSON.stringify({
      website: request.website,
      appName: request.appName,
      notifyPosts: request.notifyPosts,
      feedUrl: request.feedUrl,
      iconFiles,
    }), { encoding: "utf8", mode: 0o600 });
    await addIssueComment("Your request is in the free build queue. The APK will be linked here when it is ready. Build requests and attached icon files are public on GitHub.");
    await setOutput("ready", "true");
  } catch (error) {
    const message = error instanceof Error ? error.message : "The request could not be processed.";
    await addIssueComment(`I couldn't start this build: ${message}`);
    await setOutput("ready", "false");
  }
}

async function build() {
  const request = JSON.parse(await readFile(env("REQUEST_FILE"), "utf8"));
  const apiBase = process.env.BUILDER_API_URL || "http://127.0.0.1:3000";
  const submit = await fetch(`${apiBase}/api/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(20_000),
  });
  const job = await submit.json();
  if (submit.status !== 202) throw new Error(job.error || "The Android build could not start.");

  const deadline = Date.now() + 9 * 60 * 1000;
  let state = job;
  while (Date.now() < deadline) {
    if (state.status === "failed") throw new Error(state.message || "The Android build failed.");
    if (state.status === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const statusResponse = await fetch(`${apiBase}/api/build/${encodeURIComponent(job.id)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!statusResponse.ok) throw new Error("The Android build status could not be checked.");
    state = await statusResponse.json();
  }
  if (state.status !== "ready") throw new Error("The Android build took too long. Please try again later.");

  const downloadUrl = new URL(state.downloadUrl, `${apiBase}/`);
  if (downloadUrl.origin !== new URL(apiBase).origin || !downloadUrl.pathname.startsWith("/api/build/")) {
    throw new Error("The build service returned an invalid APK download address.");
  }
  const download = await fetch(downloadUrl, { signal: AbortSignal.timeout(60_000) });
  if (!download.ok) throw new Error("The finished APK could not be downloaded.");
  const apk = Buffer.from(await download.arrayBuffer());
  if (apk.length < 1024 || apk.length > 100 * 1024 * 1024 || apk[0] !== 0x50 || apk[1] !== 0x4b) {
    throw new Error("The build service returned an invalid APK file.");
  }
  const apkPath = path.resolve(env("APK_PATH"));
  const runnerTemp = path.resolve(process.env.RUNNER_TEMP || os.tmpdir());
  if (!apkPath.startsWith(`${runnerTemp}${path.sep}`)) throw new Error("The APK output path is invalid.");
  await mkdir(path.dirname(apkPath), { recursive: true });
  await writeFile(apkPath, apk, { mode: 0o600 });
  process.stdout.write(`APK ready (${apk.length} bytes).\n`);
}

async function complete() {
  if (process.env.REQUEST_READY !== "true") return;
  const runUrl = `${env("GITHUB_SERVER_URL")}/${env("GITHUB_REPOSITORY")}/actions/runs/${env("GITHUB_RUN_ID")}`;
  const successful = process.env.BUILD_OUTCOME === "success" && process.env.UPLOAD_OUTCOME === "success";
  if (successful) {
    const artifactUrl = process.env.ARTIFACT_URL || runUrl;
    await addIssueComment(`Your APK is ready. [Download the APK from this GitHub Actions artifact](${artifactUrl}). A free GitHub sign-in is required, and this download expires after one day.\n\n[Open build details](${runUrl})`);
  } else {
    await addIssueComment(`The APK build did not finish successfully. [Open the build details](${runUrl}) and check that the website is public and uses HTTPS.`);
  }
}

const mode = process.argv[2];
try {
  if (mode === "prepare") await prepare();
  else if (mode === "build") await build();
  else if (mode === "complete") await complete();
  else throw new Error("Choose prepare, build, or complete.");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Build request failed."}\n`);
  process.exitCode = 1;
}
