/**
 * background.js (service worker)
 * Minimal: handles screenshot capture requests (captureVisibleTab needs an
 * extension context) and lets the toolbar icon toggle the overlay.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "ps-capture") {
    const tabId = sender.tab && sender.tab.id;
    const windowId = sender.tab && sender.tab.windowId;
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({ dataUrl: null, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true; // async response
  }
  return false;
});

// Ensure a content script is present, then toggle (covers pages loaded before install).
async function toggleOnTab(tab) {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "ps-toggle" });
  } catch (e) {
    // Content script not yet there — inject the bundle in order, then toggle.
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["src/overlay/overlay.css"] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
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
        ],
      });
      await chrome.tabs.sendMessage(tab.id, { type: "ps-toggle" });
    } catch (err) {
      /* page may disallow injection (e.g. chrome:// pages) */
    }
  }
}

// The popup handles most UI, but a direct icon click (no popup) still toggles.
chrome.action.onClicked.addListener((tab) => toggleOnTab(tab));
