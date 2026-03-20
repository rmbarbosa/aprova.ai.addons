/**
 * Aprova.ai Extension — Background Service Worker
 * Routes messages between popup, content script, and bridge server.
 * Author: Rui Barbosa @rmblda 2026
 */

const BRIDGE_URL = "http://localhost:9090";

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
    title: "Scan Opções",
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
    const text = lines.join("\n");

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

  try {
    const resp = await fetch(`${BRIDGE_URL}${endpoint}`, opts);
    return await resp.json();
  } catch (err) {
    return { error: `Bridge unreachable: ${err.message}` };
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

        case "fill": {
          // Get page scan from content script first
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!tab) {
            sendResponse({ error: "No active tab" });
            break;
          }

          // Ask content script to scan the page
          const pageScan = await chrome.tabs.sendMessage(tab.id, {
            action: "scan-page",
          });

          // Send to bridge
          const result = await bridgeRequest("/fill", "POST", {
            project: msg.project,
            pageScan,
          });

          // If we have actions, send them to content script for execution
          if (result.actions && !result.error) {
            const execResult = await chrome.tabs.sendMessage(tab.id, {
              action: "execute-actions",
              actions: result.actions,
              confirmMode: msg.confirmMode !== false,
            });
            sendResponse({ ...result, execution: execResult });
          } else {
            sendResponse(result);
          }
          break;
        }

        case "fix":
          sendResponse(
            await bridgeRequest("/fix", "POST", {
              project: msg.project,
              fieldLabel: msg.fieldLabel,
              currentValue: msg.currentValue,
              feedback: msg.feedback,
            })
          );
          break;

        case "ask": {
          const askBody = {
            project: msg.project,
            question: msg.question,
          };
          if (msg.pageScan) askBody.pageScan = msg.pageScan;
          if (msg.screenshot) askBody.screenshot = msg.screenshot;
          sendResponse(await bridgeRequest("/ask", "POST", askBody));
          break;
        }

        case "validate": {
          const [vTab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!vTab) {
            sendResponse({ error: "No active tab" });
            break;
          }
          const vScan = await chrome.tabs.sendMessage(vTab.id, {
            action: "scan-page",
          });
          sendResponse(
            await bridgeRequest("/validate", "POST", {
              project: msg.project,
              pageScan: vScan,
            })
          );
          break;
        }

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

        default:
          sendResponse({ error: `Unknown action: ${msg.action}` });
      }
    } catch (err) {
      sendResponse({ error: err.message });
    }
  })();
  return true; // keep message channel open for async response
});
