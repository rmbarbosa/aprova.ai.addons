/**
 * Aprova.ai Extension — Background Service Worker
 * Routes messages between popup, content script, and bridge server.
 * Author: Rui Barbosa @rmblda 2026
 */

const BRIDGE_URL = "http://localhost:9090";

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

        case "ask":
          sendResponse(
            await bridgeRequest("/ask", "POST", {
              project: msg.project,
              question: msg.question,
            })
          );
          break;

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
