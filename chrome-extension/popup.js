/**
 * Aprova.ai Extension — Popup Controller
 * Manages session, actions, and chat UI.
 * Author: Rui Barbosa @rmblda 2026
 */

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $status = document.getElementById("statusDot");
const $chat = document.getElementById("chat");
const $project = document.getElementById("projectSelect");
const $askInput = document.getElementById("askInput");
const $sendBtn = document.getElementById("sendBtn");
const $btnConnect = document.getElementById("btnConnect");
const $btnScan = document.getElementById("btnScan");
const $btnFill = document.getElementById("btnFill");
const $btnValidate = document.getElementById("btnValidate");
const $settingsToggle = document.getElementById("settingsToggle");
const $settingsPanel = document.getElementById("settingsPanel");
const $confirmMode = document.getElementById("confirmMode");
const $sessionSelect = document.getElementById("sessionSelect");
const $disconnectBtn = document.getElementById("disconnectBtn");

let connected = false;

// ---------------------------------------------------------------------------
// Chat helpers
// ---------------------------------------------------------------------------
function addMsg(text, type = "boris") {
  const div = document.createElement("div");
  div.className = `msg ${type}`;
  div.textContent = text;
  $chat.appendChild(div);
  $chat.scrollTop = $chat.scrollHeight;
  return div;
}

function addActionCard(title, items, stat) {
  const div = document.createElement("div");
  div.className = "action-card";
  const listHtml = items
    .map((item) => {
      const cls = item.status === "done" ? "done" : item.status === "skipped" ? "skipped" : "failed";
      return `<li><span class="${cls}">${item.status === "done" ? "\u2713" : item.status === "skipped" ? "\u23ed" : "\u2717"}</span> ${item.description || item.action?.description || item.action?.selector || "action"}</li>`;
    })
    .join("");

  div.innerHTML = `
    <div class="card-header">
      <span class="card-title">${title}</span>
      <span class="card-stat">${stat}</span>
    </div>
    <ul class="card-list">${listHtml}</ul>`;
  $chat.appendChild(div);
  $chat.scrollTop = $chat.scrollHeight;
}

function addLoading(text) {
  const div = addMsg("", "boris");
  div.innerHTML = `<span class="loading"></span>${text}`;
  return div;
}

function setConnected(val) {
  connected = val;
  $status.className = `status-dot ${val ? "connected" : ""}`;
  $status.title = val ? "Connected" : "Disconnected";
  $btnScan.disabled = !val;
  $btnFill.disabled = !val;
  $btnValidate.disabled = !val;
  $askInput.disabled = !val;
  $sendBtn.disabled = !val;
  $btnConnect.querySelector(".icon").textContent = val ? "\u23f8" : "\u25b6";
  $btnConnect.lastChild.textContent = val ? " Pause" : " Connect";
}

// ---------------------------------------------------------------------------
// Bridge messaging
// ---------------------------------------------------------------------------
function sendToBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp || {}));
  });
}

// ---------------------------------------------------------------------------
// Init — check bridge status + load sessions
// ---------------------------------------------------------------------------
async function init() {
  const status = await sendToBg({ action: "bridge-status" });
  if (status.error) {
    addMsg("Bridge server offline. Start with: py -3 aprova-ai-bridge.py", "error");
    return;
  }
  addMsg("Bridge server online", "system");

  // Check if any project already has a session
  if (status.sessions) {
    for (const [proj, info] of Object.entries(status.sessions)) {
      setConnected(true);
      $project.value = proj;
      addMsg(`Session active: ${info.session_id.substring(0, 12)}...`, "system");
    }
  }

  // Load existing sessions for attach
  const list = await sendToBg({ action: "session-list" });
  if (list.sessions) {
    list.sessions.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.sessionId;
      opt.textContent = `${s.sessionId.substring(0, 16)}... ${s.lastMessage ? "- " + s.lastMessage.substring(0, 30) : ""}`;
      $sessionSelect.appendChild(opt);
    });
  }

  // Load saved project selection
  const saved = await chrome.storage.local.get(["project", "confirmMode"]);
  if (saved.project) $project.value = saved.project;
  if (saved.confirmMode !== undefined) $confirmMode.checked = saved.confirmMode;
}

// ---------------------------------------------------------------------------
// Connect / Disconnect
// ---------------------------------------------------------------------------
$btnConnect.addEventListener("click", async () => {
  if (connected) {
    // Disconnect
    const resp = await sendToBg({
      action: "session-end",
      project: $project.value,
    });
    setConnected(false);
    addMsg(`Session ended (${resp.status || "ok"})`, "system");
    return;
  }

  const project = $project.value;
  const existingSession = $sessionSelect.value;

  // Save selection
  chrome.storage.local.set({ project, confirmMode: $confirmMode.checked });

  $status.className = "status-dot connecting";
  const loading = addLoading(
    existingSession ? "Attaching to session..." : "Starting new session..."
  );

  let resp;
  if (existingSession) {
    resp = await sendToBg({
      action: "session-attach",
      sessionId: existingSession,
      project,
    });
  } else {
    resp = await sendToBg({ action: "session-start", project });
  }

  loading.remove();

  if (resp.error) {
    addMsg(`Connection failed: ${resp.error}`, "error");
    $status.className = "status-dot";
    return;
  }

  setConnected(true);
  addMsg(resp.message || `Connected (${resp.sessionId?.substring(0, 12)}...)`, "boris");
});

$disconnectBtn.addEventListener("click", async () => {
  if (!connected) return;
  const resp = await sendToBg({
    action: "session-end",
    project: $project.value,
  });
  setConnected(false);
  addMsg("Disconnected", "system");
});

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
$btnScan.addEventListener("click", async () => {
  const loading = addLoading("Scanning page...");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    loading.remove();
    addMsg("No active tab", "error");
    return;
  }

  try {
    const scan = await chrome.tabs.sendMessage(tab.id, { action: "scan-page" });
    loading.remove();

    const fieldCount = scan.fields?.length || 0;
    const filledCount = scan.fields?.filter((f) => f.currentValue).length || 0;
    const btnCount = scan.buttons?.length || 0;

    addMsg(
      `Page: ${scan.pageContext?.title || "?"}\n` +
        `Fields: ${fieldCount} (${filledCount} filled)\n` +
        `Buttons: ${btnCount}\n` +
        `Tab: ${scan.pageContext?.activeTab || "-"}`,
      "boris"
    );
  } catch (err) {
    loading.remove();
    addMsg(`Scan failed: ${err.message}. Is this a supported portal?`, "error");
  }
});

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------
$btnFill.addEventListener("click", async () => {
  addMsg("Fill Page", "user");
  const loading = addLoading("Analysing form and generating actions...");

  const resp = await sendToBg({
    action: "fill",
    project: $project.value,
    confirmMode: $confirmMode.checked,
  });

  loading.remove();

  if (resp.error) {
    addMsg(`Fill failed: ${resp.error}`, "error");
    return;
  }

  // Show alerts
  if (resp.alerts?.length) {
    resp.alerts.forEach((a) => addMsg(`\u26a0 ${a}`, "error"));
  }

  // Show execution results
  if (resp.execution?.results) {
    const results = resp.execution.results;
    const done = results.filter((r) => r.status === "done").length;
    const total = results.length;
    addActionCard("Fill completed", results, `${done}/${total} fields`);
  } else if (resp.actions) {
    addMsg(`${resp.actions.length} actions ready — sending to page...`, "boris");
    // Execute actions on page
    const execResp = await sendToBg({
      action: "execute-actions-on-page",
      actions: resp.actions,
      confirmMode: $confirmMode.checked,
    });
    if (execResp.results) {
      const done = execResp.results.filter((r) => r.status === "done").length;
      addActionCard("Fill completed", execResp.results, `${done}/${execResp.results.length}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------
$btnValidate.addEventListener("click", async () => {
  addMsg("Validate", "user");
  const loading = addLoading("Validating form values...");

  const resp = await sendToBg({
    action: "validate",
    project: $project.value,
  });

  loading.remove();

  if (resp.error) {
    addMsg(`Validation failed: ${resp.error}`, "error");
    return;
  }

  if (resp.validations) {
    const items = resp.validations.map((v) => ({
      status: v.status === "ok" ? "done" : v.status === "warning" ? "skipped" : "not_found",
      description: `${v.field}: ${v.message}`,
    }));
    const ok = resp.validations.filter((v) => v.status === "ok").length;
    addActionCard("Validation", items, `${ok}/${resp.validations.length} OK`);
  }

  if (resp.summary) {
    addMsg(resp.summary, "boris");
  }
});

// ---------------------------------------------------------------------------
// Ask Boris
// ---------------------------------------------------------------------------
async function askBoris() {
  const question = $askInput.value.trim();
  if (!question) return;

  addMsg(question, "user");
  $askInput.value = "";

  const loading = addLoading("Thinking...");

  const resp = await sendToBg({
    action: "ask",
    project: $project.value,
    question,
  });

  loading.remove();

  if (resp.error) {
    addMsg(`Error: ${resp.error}`, "error");
    return;
  }

  addMsg(resp.answer || "No response", "boris");
}

$sendBtn.addEventListener("click", askBoris);
$askInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    askBoris();
  }
});

// ---------------------------------------------------------------------------
// Settings toggle
// ---------------------------------------------------------------------------
$settingsToggle.addEventListener("click", () => {
  $settingsPanel.classList.toggle("open");
});

$confirmMode.addEventListener("change", () => {
  chrome.storage.local.set({ confirmMode: $confirmMode.checked });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
init();
