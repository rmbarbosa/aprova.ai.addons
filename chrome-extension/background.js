/**
 * Aprova.ai Extension — Background Service Worker
 * Routes messages between popup, content script, and bridge server.
 * Author: Rui Barbosa @rmblda 2026
 */

// Load RPA module (isolated — remove this line to disable RPA)
importScripts("rpa.js");

let BRIDGE_URL = "http://localhost:9090";

// Load saved bridge URL from storage
chrome.storage.sync.get(["bridgeUrl"], (data) => {
  if (data.bridgeUrl) BRIDGE_URL = data.bridgeUrl;
});

// Listen for bridge URL changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.bridgeUrl?.newValue) {
    BRIDGE_URL = changes.bridgeUrl.newValue;
  }
});

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ---------------------------------------------------------------------------
// Context menu — "Scan Opções" for select fields
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "scan-select-options",
    title: "Scan Opções Select",
    contexts: ["all"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "scan-select-options" || !tab?.id) return;

  chrome.tabs.sendMessage(tab.id, { action: "scan-select-options" }, (data) => {
    if (chrome.runtime.lastError || !data || data.error) return;

    // Format options as readable text for the input box
    const items = data.fields || [data];
    const lines = items.map((f) => {
      const id = f.label || f.name || "Campo";
      const optionsList = f.options.map((o) => o.text).join(", ");
      if (f.columnHeader) {
        return `${f.columnHeader}: ${id}:\n${optionsList}`;
      }
      return `[${id}]: ${optionsList}`;
    });
    const text = lines.join("\n") + "\n\n";

    // Send to side panel to insert into input box
    chrome.runtime.sendMessage({ action: "insert-field-options", text });
  });
});

// ---------------------------------------------------------------------------
// Full-page screenshot via DevTools Protocol
// ---------------------------------------------------------------------------

function debuggerSend(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

async function captureFullPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab");

  const target = { tabId: tab.id };

  // Attach debugger
  await new Promise((resolve, reject) => {
    chrome.debugger.attach(target, "1.3", () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });

  try {
    // Get full page dimensions
    const layout = await debuggerSend(target, "Page.getLayoutMetrics");
    const { width, height } = layout.cssContentSize || layout.contentSize;

    // Override device metrics to full page size
    await debuggerSend(target, "Emulation.setDeviceMetricsOverride", {
      width: Math.ceil(width),
      height: Math.ceil(height),
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Wait a beat for re-layout
    await new Promise((r) => setTimeout(r, 150));

    // Capture screenshot
    const screenshot = await debuggerSend(target, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });

    // Reset device metrics
    await debuggerSend(target, "Emulation.clearDeviceMetricsOverride");

    return `data:image/png;base64,${screenshot.data}`;
  } finally {
    // Always detach
    chrome.debugger.detach(target, () => {});
  }
}

// ---------------------------------------------------------------------------
// Bridge API helpers
// ---------------------------------------------------------------------------

async function bridgeRequest(endpoint, method = "GET", body = null) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);

  // Long timeout for session-start/attach (Claude reads files), short for others
  const isLong = endpoint.startsWith("/session/start") || endpoint.startsWith("/session/attach");
  const timeoutMs = isLong ? 120000 : 15000;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(`${BRIDGE_URL}${endpoint}`, {
        ...opts,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return await resp.json();
    } catch (err) {
      if (attempt === 0 && !isLong && (err.name === "TimeoutError" || err.name === "AbortError")) {
        continue; // retry once on timeout (only for short requests)
      }
      return { error: `Bridge unreachable: ${err.message}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Message handler — from popup and content script
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        case "bridge-status":
          sendResponse(await bridgeRequest("/status"));
          break;

        case "capture-tab":
          try {
            const dataUrl = await captureFullPage();
            sendResponse({ dataUrl });
          } catch (err) {
            sendResponse({ error: err.message });
          }
          break;

        case "session-list":
          sendResponse(await bridgeRequest("/session/list"));
          break;

        case "session-start":
          sendResponse(
            await bridgeRequest("/session/start", "POST", {
              project: msg.project,
              initialPrompt: msg.initialPrompt || "",
            })
          );
          break;

        case "session-attach":
          sendResponse(
            await bridgeRequest("/session/attach", "POST", {
              sessionId: msg.sessionId,
              project: msg.project,
            })
          );
          break;

        case "session-end":
          sendResponse(
            await bridgeRequest("/session/end", "POST", {
              project: msg.project,
            })
          );
          break;

        case "push-page-state":
          sendResponse(
            await bridgeRequest("/browser/state", "POST", {
              pageScan: msg.pageScan,
              tabUrl: msg.url,
              tabTitle: msg.title,
              timestamp: Date.now() / 1000,
            })
          );
          break;

        case "execute-actions-on-page": {
          // Forward actions to content script
          const [aTab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!aTab) {
            sendResponse({ error: "No active tab" });
            break;
          }
          sendResponse(
            await chrome.tabs.sendMessage(aTab.id, {
              action: "execute-actions",
              actions: msg.actions,
              confirmMode: msg.confirmMode,
            })
          );
          break;
        }

        // RPA module message routing
        case "rpa-record-start":
          sendResponse(await RPA.startRecording());
          break;
        case "rpa-record-stop":
          sendResponse(await RPA.stopRecording());
          break;
        case "rpa-record-status":
          sendResponse({ recording: RPA.isRecording(), captures: RPA.getCaptures() });
          break;
        case "rpa-save-template":
          sendResponse(await bridgeRequest("/template/save", "POST", {
            project: msg.project,
            template: msg.template,
          }));
          break;
        default:
          sendResponse({ error: `Unknown action: ${msg.action}` });
      }
    } catch (err) {
      sendResponse({ error: err.message });
    }
  })();
  return true; // keep message channel open for async response
});
