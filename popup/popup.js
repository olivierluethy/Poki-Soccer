/**
 * popup.js
 * Drives the overlay on the active tab. Ensures the content bundle is injected
 * (covers game tabs opened before the extension loaded), then routes actions.
 */
const CONTENT_FILES = [
  "src/game/geometry.js",
  "src/game/board.js",
  "src/game/physics.js",
  "src/game/collision.js",
  "src/game/boardDetector.js",
  "src/game/trajectorySolver.js",
  "src/calibration/physicsCalibration.js",
  "src/overlay/trajectoryRenderer.js",
  "src/overlay/overlay.js",
  "src/content/content.js",
];

const noteEl = document.getElementById("note");

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ps-status" });
    return true; // already present
  } catch (e) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/overlay/overlay.css"] });
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
      return true;
    } catch (err) {
      noteEl.classList.add("err");
      noteEl.textContent = "Can't run here. Open the Soccer 5 game in a normal web page (not a chrome:// or extension page) and try again.";
      return false;
    }
  }
}

async function send(msg) {
  const tab = await activeTab();
  if (!tab || !tab.id) return;
  const ok = await ensureInjected(tab.id);
  if (!ok) return;
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    /* ignore */
  }
}

document.getElementById("open").addEventListener("click", async () => {
  await send({ type: "ps-show" });
  window.close();
});

document.getElementById("analyze").addEventListener("click", async () => {
  await send({ type: "ps-analyze" });
  window.close();
});

document.querySelectorAll("[data-mode]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    await send({ type: "ps-set-mode", mode: btn.dataset.mode });
    window.close();
  });
});
