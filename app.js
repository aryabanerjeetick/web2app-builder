const form = document.querySelector("#build-form");
const websiteInput = document.querySelector("#website-url");
const appNameInput = document.querySelector("#app-name");
const charCount = document.querySelector("#char-count");
const formError = document.querySelector("#form-error");
const buildButton = document.querySelector("#build-button");
const serviceNotice = document.querySelector("#service-notice");
const serviceNoticeTitle = document.querySelector("#service-notice-title");
const serviceNoticeMessage = document.querySelector("#service-notice-message");
const localBuilderLink = document.querySelector("#local-builder-link");
const deployBuilderLink = document.querySelector("#deploy-builder-link");
const progressPanel = document.querySelector("#build-progress");
const progressTitle = document.querySelector("#progress-title");
const progressMessage = document.querySelector("#progress-message");
const progressKicker = document.querySelector("#progress-kicker");
const resultPanel = document.querySelector("#build-result");
const resultTitle = document.querySelector("#result-title");
const downloadLink = document.querySelector("#download-link");
const buildAnotherButton = document.querySelector("#build-another");
const notifyPostsInput = document.querySelector("#notify-posts");
const feedFields = document.querySelector("#feed-fields");
const feedUrlInput = document.querySelector("#feed-url");
const bloggerFeedButton = document.querySelector("#blogger-feed-button");
const iconOption = document.querySelector("#icon-option");
const iconFileInput = document.querySelector("#icon-file");
const iconFileLabel = document.querySelector("#icon-file-label");
const iconEditor = document.querySelector("#icon-editor");
const iconCanvas = document.querySelector("#icon-canvas");
const iconContext = iconCanvas.getContext("2d", { willReadFrequently: false });
const iconZoomInput = document.querySelector("#icon-zoom");
const iconZoomValue = document.querySelector("#icon-zoom-value");
const iconError = document.querySelector("#icon-error");
const removeIconButton = document.querySelector("#remove-icon");
let suggestedFeedUrl = "";

let suggestedName = "";
let latestJobId = null;
let selectedIcon = null;
let selectedIconUrl = "";
let cropZoom = 1;
let cropOffsetX = 0;
let cropOffsetY = 0;
let dragPoint = null;
const configurableInputs = [websiteInput, appNameInput, notifyPostsInput, feedUrlInput, iconFileInput, iconZoomInput, removeIconButton, bloggerFeedButton];
const iconDensities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const API_BASE = typeof window.WEB2APP_API_BASE === "string" ? window.WEB2APP_API_BASE.replace(/\/$/, "") : "";

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

async function checkBuilderService() {
  if (window.location.protocol === "file:") {
    serviceNotice.hidden = false;
    serviceNoticeTitle.textContent = "Open the builder server to create an APK";
    serviceNoticeMessage.textContent = "This local file preview is styled, but APK builds need the server. Start it with Docker Compose, then use the link below.";
    localBuilderLink.hidden = false;
    deployBuilderLink.hidden = true;
    buildButton.disabled = true;
    buildButton.querySelector(".button-label").textContent = "Open the builder server to build";
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(apiUrl("/api/health"), { cache: "no-store", signal: controller.signal });
    } finally {
      window.clearTimeout(timeout);
    }
    if (!response.ok) throw new Error("The builder server did not respond.");
    serviceNotice.hidden = true;
    localBuilderLink.hidden = true;
    deployBuilderLink.hidden = true;
    buildButton.disabled = false;
  } catch {
    serviceNotice.hidden = false;
    localBuilderLink.hidden = true;
    if (window.location.hostname.endsWith(".github.io")) {
      serviceNoticeTitle.textContent = "One quick setup unlocks APK builds";
      serviceNoticeMessage.textContent = "GitHub Pages hosts this page, while APK builds need a separate server. Choose Set up the build server, sign in to Render, review the service, and approve its current $25/month plan. When deployment finishes, refresh this page.";
      deployBuilderLink.hidden = false;
    } else {
      serviceNoticeTitle.textContent = "The APK builder server is offline";
      serviceNoticeMessage.textContent = "The page is ready, but APK builds are unavailable until the server is running.";
      deployBuilderLink.hidden = true;
    }
    buildButton.disabled = true;
  }
}

function suggestedAppName(rawWebsite) {
  try {
    const normalized = rawWebsite.includes("://") ? rawWebsite : `https://${rawWebsite}`;
    const host = new URL(normalized).hostname.replace(/^www\./i, "");
    const firstLabel = host.split(".")[0];
    return firstLabel
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase())
      .slice(0, 32);
  } catch {
    return "";
  }
}

function bloggerFeedUrl(rawWebsite) {
  try {
    const url = new URL(normalizeWebsite(rawWebsite));
    url.pathname = "/feeds/posts/default";
    url.search = "?alt=rss";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function updateFeedVisibility() {
  feedFields.hidden = !notifyPostsInput.checked;
  feedUrlInput.required = notifyPostsInput.checked;
  if (notifyPostsInput.checked && websiteInput.value.trim() && (!feedUrlInput.value.trim() || feedUrlInput.value === suggestedFeedUrl)) {
    const url = bloggerFeedUrl(websiteInput.value.trim());
    if (url && /(^|\.)blogspot\.com$/i.test(new URL(url).hostname)) {
      feedUrlInput.value = url;
      suggestedFeedUrl = url;
    } else if (feedUrlInput.value === suggestedFeedUrl) {
      feedUrlInput.value = "";
      suggestedFeedUrl = "";
    }
  }
}

notifyPostsInput.addEventListener("change", updateFeedVisibility);

bloggerFeedButton.addEventListener("click", () => {
  const feedUrl = bloggerFeedUrl(websiteInput.value.trim());
  if (!feedUrl) {
    setFormMessage("Enter your website address first so we can prepare its Blogger feed.");
    websiteInput.focus();
    return;
  }
  feedUrlInput.value = feedUrl;
  suggestedFeedUrl = feedUrl;
  setFormMessage("");
});

feedUrlInput.addEventListener("input", () => {
  if (feedUrlInput.value !== suggestedFeedUrl) suggestedFeedUrl = "";
});

function showIconMessage(message) {
  iconError.textContent = message;
  iconError.hidden = !message;
}

function clampCropOffset() {
  if (!selectedIcon) return;
  const size = iconCanvas.width;
  const scale = Math.max(size / selectedIcon.naturalWidth, size / selectedIcon.naturalHeight) * cropZoom;
  const width = selectedIcon.naturalWidth * scale;
  const height = selectedIcon.naturalHeight * scale;
  cropOffsetX = Math.max((size - width) / 2, Math.min(0, cropOffsetX));
  cropOffsetY = Math.max((size - height) / 2, Math.min(0, cropOffsetY));
}

function renderIconCrop() {
  const size = iconCanvas.width;
  iconContext.clearRect(0, 0, size, size);
  if (!selectedIcon) return;
  clampCropOffset();
  const scale = Math.max(size / selectedIcon.naturalWidth, size / selectedIcon.naturalHeight) * cropZoom;
  const width = selectedIcon.naturalWidth * scale;
  const height = selectedIcon.naturalHeight * scale;
  const x = (size - width) / 2 + cropOffsetX;
  const y = (size - height) / 2 + cropOffsetY;
  iconContext.drawImage(selectedIcon, x, y, width, height);
}

function loadLocalImage(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, objectUrl });
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("This picture could not be opened. Try a PNG, JPG, or WebP image."));
    };
    image.src = objectUrl;
  });
}

iconFileInput.addEventListener("change", async () => {
  showIconMessage("");
  const file = iconFileInput.files?.[0];
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    showIconMessage("Choose a PNG, JPG, or WebP image.");
    iconFileInput.value = "";
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showIconMessage("This picture is over 10 MB. Choose a smaller image.");
    iconFileInput.value = "";
    return;
  }
  try {
    const { image, objectUrl } = await loadLocalImage(file);
    if (image.naturalWidth > 12000 || image.naturalHeight > 12000 || image.naturalWidth * image.naturalHeight > 40_000_000) {
      URL.revokeObjectURL(objectUrl);
      throw new Error("This picture is too large to crop safely. Choose an image under 40 megapixels.");
    }
    if (selectedIconUrl) URL.revokeObjectURL(selectedIconUrl);
    selectedIcon = image;
    selectedIconUrl = objectUrl;
    cropZoom = 1;
    cropOffsetX = 0;
    cropOffsetY = 0;
    iconZoomInput.value = "100";
    iconZoomValue.textContent = "100%";
    iconFileLabel.textContent = file.name;
    iconEditor.hidden = false;
    iconOption.open = true;
    renderIconCrop();
    if (Math.min(image.naturalWidth, image.naturalHeight) < 192) {
      showIconMessage("This image is smaller than 192 × 192 px, so the launcher icon may look soft.");
    }
  } catch (error) {
    showIconMessage(error.message);
    iconFileInput.value = "";
  }
});

iconZoomInput.addEventListener("input", () => {
  cropZoom = Number(iconZoomInput.value) / 100;
  iconZoomValue.textContent = `${iconZoomInput.value}%`;
  renderIconCrop();
});

iconCanvas.addEventListener("pointerdown", (event) => {
  if (!selectedIcon) return;
  iconCanvas.setPointerCapture(event.pointerId);
  const bounds = iconCanvas.getBoundingClientRect();
  dragPoint = { x: event.clientX, y: event.clientY, scale: iconCanvas.width / bounds.width };
});

iconCanvas.addEventListener("pointermove", (event) => {
  if (!dragPoint || !selectedIcon) return;
  cropOffsetX += (event.clientX - dragPoint.x) * dragPoint.scale;
  cropOffsetY += (event.clientY - dragPoint.y) * dragPoint.scale;
  dragPoint.x = event.clientX;
  dragPoint.y = event.clientY;
  renderIconCrop();
});

iconCanvas.addEventListener("pointerup", () => { dragPoint = null; });
iconCanvas.addEventListener("pointercancel", () => { dragPoint = null; });

removeIconButton.addEventListener("click", () => {
  selectedIcon = null;
  if (selectedIconUrl) URL.revokeObjectURL(selectedIconUrl);
  selectedIconUrl = "";
  iconFileInput.value = "";
  iconFileLabel.textContent = "Choose an icon picture";
  iconEditor.hidden = true;
  showIconMessage("");
  iconContext.clearRect(0, 0, iconCanvas.width, iconCanvas.height);
});

function canvasPng(canvas) {
  return canvas.toDataURL("image/png");
}

function makeIconImageSets() {
  if (!selectedIcon) return null;
  renderIconCrop();
  const launcher = {};
  const foreground = {};
  for (const [density, dimension] of Object.entries(iconDensities)) {
    const launcherCanvas = document.createElement("canvas");
    launcherCanvas.width = dimension;
    launcherCanvas.height = dimension;
    const launcherContext = launcherCanvas.getContext("2d");
    launcherContext.fillStyle = "#6757E8";
    launcherContext.fillRect(0, 0, dimension, dimension);
    launcherContext.drawImage(iconCanvas, 0, 0, dimension, dimension);
    launcher[density] = canvasPng(launcherCanvas);

    const foregroundCanvas = document.createElement("canvas");
    foregroundCanvas.width = dimension;
    foregroundCanvas.height = dimension;
    const foregroundContext = foregroundCanvas.getContext("2d");
    const inset = dimension * 0.17;
    foregroundContext.drawImage(iconCanvas, inset, inset, dimension - inset * 2, dimension - inset * 2);
    foreground[density] = canvasPng(foregroundCanvas);
  }
  return { launcher, foreground };
}

websiteInput.addEventListener("input", () => {
  const nextSuggestion = suggestedAppName(websiteInput.value.trim());
  if (!appNameInput.value.trim() || appNameInput.value === suggestedName) {
    appNameInput.value = nextSuggestion;
    suggestedName = nextSuggestion;
    updateCharacterCount();
  }
  updateFeedVisibility();
});

appNameInput.addEventListener("input", () => {
  updateCharacterCount();
  if (appNameInput.value !== suggestedName) suggestedName = "";
});

function updateCharacterCount() {
  charCount.textContent = `${Array.from(appNameInput.value).length}/32`;
}

function setFormMessage(message) {
  formError.textContent = message;
  formError.hidden = !message;
}

function setBusy(isBusy) {
  buildButton.disabled = isBusy;
  for (const input of configurableInputs) input.disabled = isBusy;
  buildButton.querySelector(".button-label").textContent = isBusy ? "Building your app…" : "Build my Android app";
  form.hidden = isBusy;
}

function normalizeWebsite(rawWebsite) {
  const trimmed = rawWebsite.trim();
  return trimmed.includes("://") ? trimmed : `https://${trimmed}`;
}

function describeStatus(status, message) {
  if (status === "queued") {
    progressKicker.textContent = "IN THE BUILD QUEUE";
    progressTitle.textContent = "Your turn is coming up…";
    progressMessage.textContent = message || "We’ll start as soon as a build slot is free.";
    document.querySelector("#queue-note").textContent = "Keep this tab open; your download will appear here.";
  } else {
    progressKicker.textContent = "BUILDING YOUR APP";
    progressTitle.textContent = "Putting it all together…";
    progressMessage.textContent = message || "The first build may take a few minutes.";
    document.querySelector("#queue-note").textContent = "Keep this tab open; your download will appear here.";
  }
}

async function readResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    const error = new Error("The build service returned an unreadable response. Please try again.");
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(payload.error || "The build service could not start your app.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function pollJob(jobId) {
  while (latestJobId === jobId) {
    await new Promise((resolve) => window.setTimeout(resolve, 1600));
    let job;
    try {
      const response = await fetch(apiUrl(`/api/build/${encodeURIComponent(jobId)}`), { cache: "no-store" });
      job = await readResponse(response);
    } catch (error) {
      if (error.status === 404) throw error;
      progressMessage.textContent = error.message;
      progressKicker.textContent = "RECONNECTING";
      await new Promise((resolve) => window.setTimeout(resolve, 3000));
      continue;
    }

    if (job.status === "ready") {
      progressPanel.hidden = true;
      resultPanel.hidden = false;
      resultTitle.textContent = `${job.appName} is ready`;
      downloadLink.href = apiUrl(job.downloadUrl);
      downloadLink.setAttribute("download", `${job.appName.replace(/[^a-z0-9]+/gi, "-")}.apk`);
      setBusy(false);
      form.hidden = true;
      return;
    }

    if (job.status === "failed") {
      throw new Error(job.message || "The app could not be built. Please try again.");
    }
    describeStatus(job.status, job.message);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setFormMessage("");
  websiteInput.value = normalizeWebsite(websiteInput.value);

  if (!websiteInput.checkValidity()) {
    websiteInput.focus();
    setFormMessage("Enter a website address to continue.");
    return;
  }
  if (!appNameInput.value.trim()) {
    appNameInput.focus();
    setFormMessage("Add a name for your app to continue.");
    return;
  }

  const notifyPosts = notifyPostsInput.checked;
  if (notifyPosts) {
    if (!feedUrlInput.value.trim()) {
      const websiteHost = new URL(websiteInput.value).hostname;
      if (/(^|\.)blogspot\.com$/i.test(websiteHost)) {
        feedUrlInput.value = bloggerFeedUrl(websiteInput.value);
        suggestedFeedUrl = feedUrlInput.value;
      }
    }
    if (!feedUrlInput.value.trim() || !feedUrlInput.checkValidity()) {
      feedUrlInput.focus();
      setFormMessage("Enter a public Atom or RSS feed address to enable post notifications.");
      return;
    }
    feedUrlInput.value = normalizeWebsite(feedUrlInput.value);
  }

  setBusy(true);
  resultPanel.hidden = true;
  progressPanel.hidden = false;
  describeStatus("queued", "Your build is being added to the queue.");

  try {
    const response = await fetch(apiUrl("/api/build"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        website: websiteInput.value,
        appName: appNameInput.value.trim(),
        notifyPosts,
        feedUrl: notifyPosts ? feedUrlInput.value : "",
        iconFiles: makeIconImageSets(),
      }),
    });
    const job = await readResponse(response);
    latestJobId = job.id;
    describeStatus(job.status, job.message);
    await pollJob(job.id);
  } catch (error) {
    latestJobId = null;
    progressPanel.hidden = true;
    setBusy(false);
    setFormMessage(error.message || "Something went wrong. Please try again.");
  }
});

buildAnotherButton.addEventListener("click", () => {
  latestJobId = null;
  resultPanel.hidden = true;
  form.hidden = false;
  websiteInput.value = "";
  appNameInput.value = "";
  notifyPostsInput.checked = false;
  feedUrlInput.value = "";
  suggestedFeedUrl = "";
  updateFeedVisibility();
  removeIconButton.click();
  suggestedName = "";
  updateCharacterCount();
  setFormMessage("");
  websiteInput.focus();
});

updateCharacterCount();
checkBuilderService();
