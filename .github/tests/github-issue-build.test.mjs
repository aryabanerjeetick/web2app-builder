import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const buildScript = path.join(projectRoot, "scripts", "github-issue-build.mjs");
const comments = [];
const apkBytes = Buffer.alloc(2048, 0x44);
apkBytes[0] = 0x50;
apkBytes[1] = 0x4b;

let temporaryDirectory;
let matchingIssues = 2;
let apiBase;
let buildPayload;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/repos/owner/repo/issues" && request.method === "GET") {
    const createdAt = new Date().toISOString();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(Array.from({ length: matchingIssues }, (_, index) => ({
      body: "<!-- WEB2APP_BUILD_REQUEST -->",
      created_at: createdAt,
      number: index + 1,
    }))));
    return;
  }
  if (url.pathname === "/repos/owner/repo/issues/42/comments" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    comments.push(JSON.parse(body).body);
    response.writeHead(201, { "content-type": "application/json" });
    response.end("{}");
    return;
  }
  if (url.pathname === "/api/build" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    buildPayload = JSON.parse(body);
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "test-id", status: "queued" }));
    return;
  }
  if (url.pathname === "/api/build/test-id" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "test-id", status: "ready", downloadUrl: "/api/build/test-id/download" }));
    return;
  }
  if (url.pathname === "/api/build/test-id/download" && request.method === "GET") {
    response.writeHead(200, {
      "content-type": "application/vnd.android.package-archive",
      "content-length": apkBytes.length,
    });
    response.end(apkBytes);
    return;
  }
  response.writeHead(404);
  response.end("not found");
});

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "web2app-queue-test-"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiBase = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function runBuildScript(mode, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [buildScript, mode], {
      cwd: projectRoot,
      env: {
        ...process.env,
        GITHUB_API_URL: apiBase,
        GITHUB_TOKEN: "test-token",
        GITHUB_REPOSITORY: "owner/repo",
        ISSUE_NUMBER: "42",
        ISSUE_AUTHOR: "alice",
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status: status ?? 1, signal, stdout, stderr });
    });
  });
}

test("public issue queue prepares, rejects, builds, and reports requests", async (context) => {
  const issueBody = [
    "<!-- WEB2APP_BUILD_REQUEST -->",
    "Website URL: https://example.com/",
    "App name: Example Site",
    "New post notifications: no",
    "Feed URL: none",
    "Icon package: none",
  ].join("\n");

  await context.test("accepts a valid third request within the free daily cap", async () => {
    matchingIssues = 3;
    const requestFile = path.join(temporaryDirectory, "request.json");
    const outputFile = path.join(temporaryDirectory, "outputs.txt");
    const result = await runBuildScript("prepare", {
      ISSUE_BODY: issueBody,
      REQUEST_FILE: requestFile,
      GITHUB_OUTPUT: outputFile,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(outputFile, "utf8"), /ready=true/);
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    assert.equal(request.website, "https://example.com/");
    assert.equal(request.appName, "Example Site");
    assert.equal(request.notifyPosts, false);
    assert.ok(comments.at(-1).includes("free build queue"));
  });

  await context.test("rejects a fourth request within 24 hours", async () => {
    matchingIssues = 4;
    const outputFile = path.join(temporaryDirectory, "limited.txt");
    const result = await runBuildScript("prepare", {
      ISSUE_BODY: issueBody,
      REQUEST_FILE: path.join(temporaryDirectory, "limited.json"),
      GITHUB_OUTPUT: outputFile,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(outputFile, "utf8"), /ready=false/);
    assert.ok(comments.at(-1).includes("3 builds per GitHub account"));
  });

  await context.test("rejects an insecure website address", async () => {
    matchingIssues = 0;
    const outputFile = path.join(temporaryDirectory, "invalid.txt");
    const result = await runBuildScript("prepare", {
      ISSUE_BODY: issueBody.replace("https://example.com/", "http://localhost"),
      REQUEST_FILE: path.join(temporaryDirectory, "invalid.json"),
      GITHUB_OUTPUT: outputFile,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(outputFile, "utf8"), /ready=false/);
    assert.ok(comments.at(-1).includes("valid public HTTPS"));
  });

  await context.test("polls the builder and validates the APK download", async () => {
    const runnerDirectory = path.join(temporaryDirectory, "runner");
    await mkdir(runnerDirectory);
    const requestFile = path.join(temporaryDirectory, "build-request.json");
    await writeFile(requestFile, JSON.stringify({
      website: "https://example.com/",
      appName: "Example Site",
      notifyPosts: false,
      feedUrl: "",
      iconFiles: null,
    }));
    const apkPath = path.join(runnerDirectory, "output.apk");
    const result = await runBuildScript("build", {
      REQUEST_FILE: requestFile,
      APK_PATH: apkPath,
      RUNNER_TEMP: runnerDirectory,
      BUILDER_API_URL: apiBase,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(buildPayload.appName, "Example Site");
    const apk = await readFile(apkPath);
    assert.equal(apk.length, 2048);
    assert.equal(apk[0], 0x50);
    assert.equal(apk[1], 0x4b);
  });

  await context.test("posts a success comment with the temporary artifact link", async () => {
    const result = await runBuildScript("complete", {
      REQUEST_READY: "true",
      BUILD_OUTCOME: "success",
      UPLOAD_OUTCOME: "success",
      ARTIFACT_URL: "https://github.com/owner/repo/actions/runs/99/artifacts/4",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "99",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(comments.at(-1).includes("Download the APK"));
    assert.ok(comments.at(-1).includes("expires after one day"));
  });
});
