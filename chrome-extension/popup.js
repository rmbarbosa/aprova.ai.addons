/**
 * Aprova.ai Extension — Popup Controller
 * Session-first UX: lobby screen → connected screen.
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
const $headerMenuBtn = document.getElementById("headerMenuBtn");
const $headerMenu = document.getElementById("headerMenu");
const $settingsToggle = document.getElementById("settingsToggle");
const $settingsPanel = document.getElementById("settingsPanel");
const $disconnectBtn = document.getElementById("disconnectBtn");
const $clearChatBtn = document.getElementById("clearChatBtn");
const $screenshotBtn = document.getElementById("screenshotBtn");
const $attachBtn = document.getElementById("attachBtn");
const $attachMenu = document.getElementById("attachMenu");
const $attachPreview = document.getElementById("attachPreview");
const $attachPreviewImg = document.getElementById("attachPreviewImg");
const $attachPreviewRemove = document.getElementById("attachPreviewRemove");

const $timeoutSelect = document.getElementById("timeoutSelect");
const $bridgeUrlInput = document.getElementById("bridgeUrlInput");
const $permissionsSelect = document.getElementById("permissionsSelect");
const $initialPrompt = document.getElementById("initialPromptInput");
const $sessionInfo = document.getElementById("sessionInfo");
const $offlineBanner = document.getElementById("offlineBanner");

let pendingScreenshot = null; // data URL of staged screenshot
let pendingFormDesc = null; // staged form structure description text
let pendingFormDescMode = "structure"; // "structure" or "validate"
// AI Generate — exposed on window for rpa-ui.js access
window.pendingAiGenerate = false;

// Lobby refs
const $lobby = document.getElementById("lobby");
const $sessionList = document.getElementById("sessionList");
const $lobbyProject = document.getElementById("lobbyProjectSelect");
const $lobbyConnectBtn = document.getElementById("lobbyConnectBtn");
const $lobbyError = document.getElementById("lobbyError");

// ---------------------------------------------------------------------------
// Screen switching
// ---------------------------------------------------------------------------
function showScreen(screen) {
  if (screen === "lobby") {
    document.body.classList.add("no-session");
    $status.className = "status-dot";
    $status.title = "Disconnected";
  } else {
    document.body.classList.remove("no-session");
    $status.className = "status-dot connected";
    $status.title = "Connected";
  }
}

// ---------------------------------------------------------------------------
// Lightweight Markdown → HTML renderer
// ---------------------------------------------------------------------------
function renderMd(src) {
  // Escape HTML first
  let h = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Code blocks (``` ... ```) — preserve original text in data attribute for copy
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    const trimmed = code.trim();
    const b64 = btoa(unescape(encodeURIComponent(trimmed)));
    return `<pre data-raw="${b64}"><button class="copy-btn"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><code>${trimmed}</code></pre>`;
  });

  // Tables: detect lines with |
  h = h.replace(/((?:^\|.+\|$\n?)+)/gm, (_m, table) => {
    const rows = table.trim().split("\n").filter(r => r.trim());
    if (rows.length < 2) return table;
    // Check if row 2 is a separator (|---|---|)
    const isSep = /^\|[\s\-:]+\|/.test(rows[1]);
    let html = '<table>';
    rows.forEach((row, i) => {
      if (isSep && i === 1) return; // skip separator row
      const cells = row.split("|").filter((_, j, a) => j > 0 && j < a.length - 1);
      const tag = (isSep && i === 0) ? "th" : "td";
      html += "<tr>" + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join("") + "</tr>";
    });
    html += "</table>";
    return html;
  });

  // Headings
  h = h.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
  h = h.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  h = h.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  h = h.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Horizontal rules
  h = h.replace(/^---+$/gm, "<hr>");

  // Bold + italic
  h = h.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Inline code
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Unordered lists (- item)
  h = h.replace(/((?:^[\t ]*- .+$\n?)+)/gm, (_m, block) => {
    const items = block.trim().split("\n").map(l => `<li>${l.replace(/^[\t ]*- /, "")}</li>`).join("");
    return `<ul>${items}</ul>`;
  });

  // Line breaks: double newline → paragraph break, single → <br>
  h = h.replace(/\n{2,}/g, "</p><p>");
  h = h.replace(/\n/g, "<br>");
  h = `<p>${h}</p>`;

  // Clean up empty paragraphs around block elements
  h = h.replace(/<p>\s*(<(?:table|pre|ul|ol|h[1-4]|hr))/g, "$1");
  h = h.replace(/(<\/(?:table|pre|ul|ol|h[1-4])>)\s*<\/p>/g, "$1");
  h = h.replace(/<p><\/p>/g, "");

  return h;
}

// ---------------------------------------------------------------------------
// Chat helpers
// ---------------------------------------------------------------------------
const MAX_VISIBLE_MESSAGES = 60;

function _trimChat() {
  // Keep only last MAX_VISIBLE_MESSAGES children to prevent DOM bloat
  while ($chat.children.length > MAX_VISIBLE_MESSAGES) {
    $chat.removeChild($chat.firstChild);
  }
}

function addMsg(text, type = "boris") {
  const div = document.createElement("div");
  div.className = `msg ${type}`;
  if (type === "boris") {
    div.innerHTML = renderMd(text);
  } else {
    div.textContent = text;
  }
  $chat.appendChild(div);
  _trimChat();
  $chat.scrollTop = $chat.scrollHeight;
  return div;
}

function addActionCard(title, items, stat) {
  const div = document.createElement("div");
  div.className = "action-card";

  // Build JSON for inspect modal
  const inspectData = items.map((item) => {
    const obj = { status: item.status };
    if (item.action) obj.action = item.action;
    if (item.httpStatus) obj.httpStatus = item.httpStatus;
    if (item.responseBody) obj.responseBody = item.responseBody;
    if (item.usedUrl) obj.usedUrl = item.usedUrl;
    if (item.error) obj.error = item.error;
    return obj;
  });

  const listHtml = items
    .map((item) => {
      const cls = item.status === "done" ? "done" : item.status === "skipped" ? "skipped" : "failed";
      const icon = item.status === "done" ? "\u2713" : item.status === "skipped" ? "\u23ed" : "\u2717";
      const label = item.description || item.action?.description || item.action?.selector || "action";
      // Show error details for failed actions
      let errorDetail = "";
      if (item.status !== "done" && item.status !== "skipped") {
        const parts = [];
        if (item.error) parts.push(item.error);
        if (item.action?.error) parts.push(item.action.error);
        if (item.httpStatus) parts.push(`HTTP ${item.httpStatus}`);
        if (item.usedUrl) parts.push(`URL: ${item.usedUrl}`);
        if (item.responseBody) {
          const rb = typeof item.responseBody === "string" ? item.responseBody : JSON.stringify(item.responseBody);
          if (rb.length > 0) parts.push(rb.slice(0, 200));
        }
        if (parts.length) {
          const escaped = parts.join(" — ").replace(/&/g, "&amp;").replace(/</g, "&lt;");
          errorDetail = `<div style="font-size:10px;color:var(--error);margin-top:2px;word-break:break-all;">${escaped}</div>`;
        }
      }
      return `<li><span class="${cls}">${icon}</span> ${label}${errorDetail}</li>`;
    })
    .join("");

  div.innerHTML = `
    <div class="card-header">
      <span class="card-title">${title}</span>
      <span class="card-inspect" title="Ver JSON enviado" style="cursor:pointer;opacity:0.5;margin-left:4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
      <span class="card-stat">${stat}</span>
    </div>
    <ul class="card-list">${listHtml}</ul>`;

  div.querySelector(".card-inspect").addEventListener("click", () => {
    showJsonInspector(inspectData, title);
  });

  $chat.appendChild(div);
  $chat.scrollTop = $chat.scrollHeight;
}

function addLoading(text) {
  const div = addMsg("", "boris");
  div.innerHTML = `<span class="loading"></span>${text}`;
  return div;
}

function addProcessing(text = "A processar...") {
  const div = document.createElement("div");
  div.className = "processing";
  div.innerHTML = `
    <div class="processing-dots"><span></span><span></span><span></span></div>
    <span class="processing-text">${text}</span>
  `;
  $chat.appendChild(div);
  $chat.scrollTop = $chat.scrollHeight;
  return div;
}

// ---------------------------------------------------------------------------
// Processing status bar (above input) — Claude Code style
// ---------------------------------------------------------------------------
const FUN_VERBS = [
  "Befuddling", "Cogitating", "Ruminating", "Percolating", "Concocting",
  "Deliberating", "Pondering", "Marinating", "Fermenting", "Brewing",
  "Distilling", "Simmering", "Decanting", "Crystallizing", "Alchemizing",
  "Contemplating", "Unraveling", "Synthesizing", "Extrapolating", "Meditating",
];

let _procBarElapsedInterval = null;
let _procBarStartTime = null;
let _procBarVerb = "";
let _procBarStepTimeout = null;

function _formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function _randomVerb() {
  return FUN_VERBS[Math.floor(Math.random() * FUN_VERBS.length)];
}

function startProcessingBar() {
  const bar = document.getElementById("processingBar");
  const verbEl = document.getElementById("processingVerb");
  const elapsedEl = document.getElementById("processingElapsed");
  const stepEl = document.getElementById("processingStep");
  if (!bar) return;

  _procBarStartTime = Date.now();
  _procBarVerb = _randomVerb();
  verbEl.textContent = _procBarVerb;
  elapsedEl.textContent = "(0s)";
  stepEl.textContent = "";
  bar.classList.add("active");
  bar.classList.remove("done");

  // Update elapsed every second
  _procBarElapsedInterval = setInterval(() => {
    elapsedEl.textContent = `(${_formatElapsed(Date.now() - _procBarStartTime)})`;
  }, 1000);
}

function updateProcessingStep(stepText) {
  const verbEl = document.getElementById("processingVerb");
  const stepEl = document.getElementById("processingStep");
  if (!stepEl || !verbEl) return;

  // Show tool step in the step area
  stepEl.textContent = stepText;
}

function stopProcessingBar() {
  const bar = document.getElementById("processingBar");
  const verbEl = document.getElementById("processingVerb");
  const elapsedEl = document.getElementById("processingElapsed");
  const stepEl = document.getElementById("processingStep");

  clearInterval(_procBarElapsedInterval);
  clearTimeout(_procBarStepTimeout);
  _procBarElapsedInterval = null;
  _procBarStepTimeout = null;

  if (!bar) return;

  // Show final state
  const elapsed = _formatElapsed(Date.now() - _procBarStartTime);
  verbEl.textContent = _procBarVerb;
  elapsedEl.textContent = `(${elapsed})`;
  stepEl.textContent = "";
  bar.classList.add("done");

  // Hide after 4 seconds
  setTimeout(() => {
    bar.classList.remove("active", "done");
  }, 4000);
}

function renderSteps(steps) {
  if (!steps || !steps.length) return;
  steps.forEach((step) => {
    const div = document.createElement("div");
    div.className = "msg step";
    if (step.type === "tool") {
      div.textContent = step.text;
    } else if (step.type === "thinking") {
      div.textContent = step.text;
    }
    $chat.appendChild(div);
  });
  $chat.scrollTop = $chat.scrollHeight;
}

// ---------------------------------------------------------------------------
// Bridge messaging
// ---------------------------------------------------------------------------
function sendToBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp || {}));
  });
}

let BRIDGE_URL = "http://localhost:9090";

// Default initial prompt — loaded from bundled file
let DEFAULT_INITIAL_PROMPT = "";
async function loadDefaultPrompt() {
  try {
    const url = chrome.runtime.getURL("prompts/session-init-default.md");
    const resp = await fetch(url);
    DEFAULT_INITIAL_PROMPT = await resp.text();
  } catch (e) {
    console.warn("Failed to load default prompt:", e);
    DEFAULT_INITIAL_PROMPT = "";
  }
}

/**
 * Stream an /ask/stream SSE request directly from the side panel.
 * Calls onStep(text) for thinking/tool steps and onText(fullTextSoFar) for each text chunk.
 * Returns { answer, actions, alerts, error }.
 */
async function streamAsk(body, { onStep, onText, signal }) {
  const resp = await fetch(`${BRIDGE_URL}/ask/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    return { error: err.error || `HTTP ${resp.status}` };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;

      try {
        const evt = JSON.parse(payload);
        if (evt.type === "step" && onStep) {
          onStep(evt.text);
        } else if (evt.type === "text" || evt.type === "result") {
          fullText = evt.text;
          if (onText) onText(fullText);
        } else if (evt.type === "error") {
          return { error: evt.text };
        }
      } catch (_) {}
    }
  }

  return { answer: fullText };
}

// ---------------------------------------------------------------------------
// Lobby helpers
// ---------------------------------------------------------------------------
function showLobbyError(msg) {
  $lobbyError.textContent = msg;
  $lobbyError.classList.add("visible");
}

function hideLobbyError() {
  $lobbyError.classList.remove("visible");
}

function updateLobbyButton() {
  $lobbyConnectBtn.disabled = false;
}

function renderSessionList(sessions) {
  $sessionList.innerHTML = "";
  if (!sessions || sessions.length === 0) {
    $sessionList.innerHTML = '<div class="session-list-empty">Nenhuma sessão Claude Code activa</div>';
    return;
  }
  sessions.forEach((s) => {
    const card = document.createElement("div");
    card.className = "session-card";
    const cwd = (s.cwd || "").replace(/\\\\/g, "\\");
    card.innerHTML = `
      <div class="session-id">PID ${s.pid || "?"}  ${cwd}</div>
      ${s.lastMessage ? `<div class="session-msg">${s.lastMessage.substring(0, 60)}</div>` : ""}
    `;
    $sessionList.appendChild(card);
  });
}

async function loadSessionList() {
  $sessionList.innerHTML = '<div class="session-list-loading"><span class="loading"></span>A carregar sessões...</div>';
  const list = await sendToBg({ action: "session-list" });
  renderSessionList(list.sessions || []);
}

// ---------------------------------------------------------------------------
// Lobby connect button
// ---------------------------------------------------------------------------
$lobbyConnectBtn.addEventListener("click", async () => {
  hideLobbyError();

  const project = $lobbyProject.value;

  $lobbyConnectBtn.disabled = true;
  $lobbyConnectBtn.textContent = "A iniciar sessão...";
  $status.className = "status-dot connecting";

  const resp = await sendToBg({ action: "session-start", project, initialPrompt: $initialPrompt.value || "" });

  $lobbyConnectBtn.textContent = "Iniciar Sessão";

  if (resp.error) {
    showLobbyError(`Falha: ${resp.error}`);
    $status.className = "status-dot";
    updateLobbyButton();
    return;
  }

  // Success — switch to connected screen
  $project.value = project;
  chrome.storage.local.set({ project });

  showScreen("connected");
  startSessionInfo();
  startHealthCheck();
  activatePushOnTab();
  renderSteps(resp.steps);

  // Parse session init response — may contain JSON with actions/alerts/answer
  const initMsg = resp.message || "Sessão ligada";
  const initParsed = _tryParseActions(initMsg);
  if (initParsed) {
    if (initParsed.alerts?.length > 0) {
      showAlertModal(initParsed.alerts);
    }
    addMsg(initParsed.answer || "Sessão ligada", "boris");
  } else {
    addMsg(initMsg, "boris");
  }
});

// ---------------------------------------------------------------------------
// Init — check bridge status, decide which screen to show
// ---------------------------------------------------------------------------
async function fetchProjects() {
  try {
    const resp = await fetch(`${BRIDGE_URL}/projects`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.projects || [];
  } catch {
    return [];
  }
}

function populateProjectDropdowns(projects, savedProject) {
  [$lobbyProject, $project].forEach((sel) => {
    sel.innerHTML = "";
    projects.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    if (savedProject && projects.includes(savedProject)) sel.value = savedProject;
  });
}

let _sessionStartTime = null;
let _sessionInfoTimer = null;

function updateSessionInfo() {
  if (!_sessionStartTime) { $sessionInfo.textContent = ""; return; }
  const elapsed = Math.floor((Date.now() - _sessionStartTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const proj = $project.value || "";
  const short = proj.length > 14 ? proj.slice(0, 12) + "…" : proj;
  $sessionInfo.textContent = `${short} ${mins}m`;
  $sessionInfo.title = `${proj} — ${mins} min`;
}

function startSessionInfo() {
  _sessionStartTime = Date.now();
  updateSessionInfo();
  clearInterval(_sessionInfoTimer);
  _sessionInfoTimer = setInterval(updateSessionInfo, 60000);
}

function stopSessionInfo() {
  _sessionStartTime = null;
  clearInterval(_sessionInfoTimer);
  $sessionInfo.textContent = "";
}

// Health check — poll /status every 30s
let _healthTimer = null;
function startHealthCheck() {
  stopHealthCheck();
  _healthTimer = setInterval(async () => {
    try {
      const resp = await fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(5000) });
      const data = await resp.json();
      if (data.status === "ok") {
        $offlineBanner.style.display = "none";
        $status.className = "status-dot connected";
        // Check if our session still exists
        const proj = $project.value;
        if (proj && data.sessions && !data.sessions[proj]) {
          $offlineBanner.textContent = "Sessão expirou — reconectar";
          $offlineBanner.style.display = "block";
        }
      } else {
        $offlineBanner.textContent = "Bridge offline";
        $offlineBanner.style.display = "block";
        $status.className = "status-dot";
      }
    } catch {
      $offlineBanner.textContent = "Bridge offline";
      $offlineBanner.style.display = "block";
      $status.className = "status-dot";
    }
  }, 30000);
}

function stopHealthCheck() {
  if (_healthTimer) { clearInterval(_healthTimer); _healthTimer = null; }
  $offlineBanner.style.display = "none";
}

async function activatePushOnTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) chrome.tabs.sendMessage(tab.id, { action: "activate-push" }).catch(() => {});
  } catch {}
}

async function deactivatePushOnTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) chrome.tabs.sendMessage(tab.id, { action: "deactivate-push" }).catch(() => {});
  } catch {}
}

async function init() {
  // Load default prompt from bundled file
  await loadDefaultPrompt();

  // Load saved preferences (local + sync)
  const [saved, synced] = await Promise.all([
    chrome.storage.local.get(["project", "timeout"]),
    chrome.storage.sync.get(["bridgeUrl", "initialPrompt", "permissions"]),
  ]);
  if (synced.bridgeUrl) {
    BRIDGE_URL = synced.bridgeUrl;
    $bridgeUrlInput.value = synced.bridgeUrl;
  } else {
    $bridgeUrlInput.value = BRIDGE_URL;
  }
  if (synced.initialPrompt !== undefined && synced.initialPrompt !== "") {
    $initialPrompt.value = synced.initialPrompt;
  } else {
    $initialPrompt.value = DEFAULT_INITIAL_PROMPT;
  }
  if (saved.timeout) $timeoutSelect.value = saved.timeout;
  if (synced.permissions) $permissionsSelect.value = synced.permissions;

  // Fetch projects from bridge and populate dropdowns
  const projects = await fetchProjects();
  if (projects.length > 0) {
    populateProjectDropdowns(projects, saved.project);
  } else if (saved.project) {
    // Bridge offline — use saved project as single option
    populateProjectDropdowns([saved.project], saved.project);
  }

  // Check bridge status
  const status = await sendToBg({ action: "bridge-status" });
  if (status.error) {
    showLobbyError("Bridge server offline. Iniciar com: py -3 aprova_ai_bridge.py");
    $lobbyConnectBtn.disabled = true;
    return;
  }

  // If bridge already has an active session, skip lobby
  if (status.sessions && Object.keys(status.sessions).length > 0) {
    const [proj, info] = Object.entries(status.sessions)[0];
    $project.value = proj;
    showScreen("connected");
    startSessionInfo();
    startHealthCheck();
    activatePushOnTab();
    addMsg("Sessão activa — bridge ligado", "system");
    return;
  }

  // No active session — stay on lobby, load session list
  await loadSessionList();
  updateLobbyButton();
}

// ---------------------------------------------------------------------------
// Disconnect — return to lobby
// ---------------------------------------------------------------------------
$disconnectBtn.addEventListener("click", async () => {
  $headerMenu.classList.remove("open");
  const resp = await sendToBg({
    action: "session-end",
    project: $project.value,
  });
  stopSessionInfo();
  stopHealthCheck();
  deactivatePushOnTab();
  showScreen("lobby");
  $settingsPanel.classList.remove("open");
  // Refresh session list
  await loadSessionList();
  updateLobbyButton();
});

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
async function probeContentScript() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return false;
    const resp = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { action: "ping" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000)),
    ]);
    return resp?.ok === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ask Boris (smart — includes page context when relevant)
// ---------------------------------------------------------------------------
const FILL_KEYWORDS = /\b(preench|fill|preenche|completa|submete|submit|envia|send|clica|click|seleccion|select|marca|check|form|campo|field|valor|value|página|page)\b/i;

// Cache pageScan per tab for 10 seconds
let _scanCache = { tabId: null, url: null, data: null, time: 0 };
async function tryGetPageScan() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    // Return cache if same tab+url and < 10s old
    if (_scanCache.tabId === tab.id && _scanCache.url === tab.url && Date.now() - _scanCache.time < 10000) {
      return _scanCache.data;
    }
    const data = await chrome.tabs.sendMessage(tab.id, { action: "scan-page" });
    _scanCache = { tabId: tab.id, url: tab.url, data, time: Date.now() };
    return data;
  } catch {
    return null;
  }
}

let askAborted = false;
let askRunning = false;

function setAskState(running) {
  askRunning = running;
  if (running) {
    $sendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
    $sendBtn.title = "Stop";
    $sendBtn.classList.add("stop-mode");
    // Keep input enabled so user can type while waiting
  } else {
    $sendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
    $sendBtn.title = "Send";
    $sendBtn.classList.remove("stop-mode");
    $askInput.disabled = false;
    $askInput.focus();
  }
}

async function askBoris() {
  if (askRunning) {
    // Stop was clicked
    askAborted = true;
    return;
  }

  const question = $askInput.value.trim();
  const hasScreenshot = !!pendingScreenshot;
  const hasFormDesc = !!pendingFormDesc;
  const hasAiGenerate = pendingAiGenerate;
  if (!question && !hasScreenshot && !hasFormDesc && !hasAiGenerate) return;

  // Build the chat bubble — attachments on top, text below
  const defaultPrompt = hasAiGenerate
    ? "Preenche esta página do formulário usando as instâncias do projecto."
    : hasFormDesc
    ? (pendingFormDescMode === "validate"
      ? "Estrutura do formulário em anexo. Valida ou diz-me: a melhor opção para cada campo do form."
      : "Estrutura do formulário em anexo. Valida ou diz-me: a melhor opção para cada campo de selecção.")
    : hasScreenshot
      ? "O que devo preencher nesta página?"
      : "";
  const msgText = question || defaultPrompt;
  const div = document.createElement("div");
  div.className = "msg user";
  let attachHtml = "";
  if (hasScreenshot) {
    attachHtml += `<img class="screenshot-preview" src="${pendingScreenshot}" alt="screenshot"> `;
  }
  if (hasFormDesc) {
    attachHtml += `<span class="form-desc-thumb"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg><span>form structure</span></span> `;
  }
  if (hasAiGenerate) {
    attachHtml += `<span class="form-desc-thumb" style="background:rgba(168,85,247,0.15);color:#a855f7;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/></svg><span>AI Generate</span></span> `;
  }
  if (attachHtml) {
    const escaped = msgText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    div.innerHTML = `${attachHtml}<br><span style="white-space:pre-wrap">${escaped}</span>`;
  } else {
    div.textContent = msgText;
  }
  $chat.appendChild(div);
  $chat.scrollTop = $chat.scrollHeight;

  // Grab attachments before clearing
  const screenshotData = pendingScreenshot;
  const formDescData = pendingFormDesc;
  const aiGenerateData = pendingAiGenerate;
  clearPendingScreenshot();
  clearPendingFormDesc();
  pendingAiGenerate = false;
  _updateAiGenerateThumb();
  resetAskInput();
  askAborted = false;
  setAskState(true);
  startProcessingBar();

  // Attach page scan when relevant or when screenshot/formDesc is present
  const isPageRelated = FILL_KEYWORDS.test(msgText) || screenshotData || formDescData || aiGenerateData;
  let pageScan = null;

  if (isPageRelated && !formDescData) {
    const scanLoading = addLoading("A ler a página...");
    pageScan = await tryGetPageScan();
    scanLoading.remove();
    if (askAborted) { setAskState(false); stopProcessingBar(); addMsg("Cancelado", "system"); return; }
  }

  // Append form description to question if attached
  let fullQuestion = msgText;
  if (formDescData) {
    fullQuestion += "\n\nEstrutura do formulário nesta página:\n" + formDescData;
  }
  if (aiGenerateData) {
    fullQuestion += "\n\n[AI GENERATE] Lê os ficheiros FormTemplate/form_instance_*.md do projecto. " +
      "Determina qual(is) correspondem à página actual do formulário (com base nos campos visíveis e secção activa). " +
      "Para cada instância correspondente, extrai o body JSON completo (com TODOS os dados, não truncar). " +
      "Retorna como JSON: {\"actions\": [{\"type\": \"rpa_replay\", \"postUrl\": \"<URL do POST que está no form_instance>\", \"method\": \"POST\", \"body\": {<body JSON completo>}, \"description\": \"...\"}], \"answer\": \"...\"}. " +
      "IMPORTANTE: o postUrl DEVE vir do ficheiro form_instance (campo postUrl ou url). Inclui TODOS os dados do body sem truncar.";
  }

  const proc = addProcessing(
    screenshotData ? "A analisar screenshot..." :
    formDescData ? "A analisar estrutura do formulário..." :
    "A pensar..."
  );

  // Create an AbortController so Stop button and timeout can cancel the stream
  const abortCtrl = new AbortController();
  const origAbortCheck = () => { if (askAborted) abortCtrl.abort(); };

  // Timeout — read from settings (seconds → ms); 0 means no timeout
  const timeoutSec = parseInt($timeoutSelect.value);
  const timeoutId = timeoutSec > 0
    ? setTimeout(() => { abortCtrl.abort(); askAborted = true; }, timeoutSec * 1000)
    : null;

  // Live response bubble — updates progressively (throttled to 200ms)
  let responseBubble = null;
  let _renderThrottleId = null;
  let lastRenderedText = "";

  try {
    const resp = await streamAsk(
      {
        project: $project.value,
        question: fullQuestion,
        pageScan,
        screenshot: screenshotData || undefined,
        permissions: $permissionsSelect.value,
      },
      {
        onStep: (text) => {
          const stepDiv = document.createElement("div");
          stepDiv.className = "msg step";
          stepDiv.textContent = text;
          $chat.appendChild(stepDiv);
          $chat.scrollTop = $chat.scrollHeight;
          updateProcessingStep(text);
        },
        onText: (fullText) => {
          proc.remove();
          origAbortCheck();
          // Quick check: if starts with { or [, likely JSON — skip live render
          const trimmed = fullText.trimStart();
          if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            lastRenderedText = fullText;
            return;
          }
          // Throttled render: max 1 render per 200ms
          lastRenderedText = fullText;
          if (!_renderThrottleId) {
            _renderThrottleId = setTimeout(() => {
              _renderThrottleId = null;
              if (!responseBubble) {
                responseBubble = document.createElement("div");
                responseBubble.className = "msg boris";
                $chat.appendChild(responseBubble);
              }
              responseBubble.innerHTML = renderMd(lastRenderedText);
              $chat.scrollTop = $chat.scrollHeight;
            }, 200);
          }
        },
        signal: abortCtrl.signal,
      }
    );

    clearTimeout(timeoutId);
    clearTimeout(_renderThrottleId);
    _renderThrottleId = null;
    proc.remove();

    // Final render with complete text
    if (responseBubble && lastRenderedText !== (resp.answer || "")) {
      responseBubble.innerHTML = renderMd(resp.answer || lastRenderedText);
    }

    if (askAborted) {
      stopProcessingBar();
      setAskState(false);
      addMsg("Cancelado", "system");
      return;
    }

    if (resp.error) {
      addMsg(`Error: ${resp.error}`, "error");
      stopProcessingBar();
      setAskState(false);
      return;
    }

    // If response contains JSON actions/alerts, parse and handle
    if (resp.answer) {
      const parsed = _tryParseActions(resp.answer);

      if (parsed) {
        // Execute actions if any
        if (parsed.actions?.length > 0 && !askAborted) {
          addMsg(`${parsed.actions.length} acções detectadas — a executar...`, "boris");
          const execResp = await sendToBg({
            action: "execute-actions-on-page",
            actions: parsed.actions,
            confirmMode: true,
          });
          if (execResp.results) {
            console.log("[AI Generate] action results:", JSON.stringify(execResp.results, null, 2));
            const done = execResp.results.filter((r) => r.status === "done").length;
            addActionCard("Acções executadas", execResp.results, `${done}/${execResp.results.length}`);
          } else {
            console.log("[AI Generate] no results in execResp:", execResp);
            if (execResp.error) addMsg(`Erro: ${execResp.error}`, "error");
          }
        }

        // Show alerts as modal dialog
        if (parsed.alerts?.length > 0) {
          await showAlertModal(parsed.alerts);
        }

        // Show the textual answer (not the raw JSON)
        const displayAnswer = parsed.answer || null;
        if (displayAnswer) {
          if (responseBubble) {
            responseBubble.innerHTML = renderMd(displayAnswer);
          } else {
            addMsg(displayAnswer, "boris");
          }
        } else if (!responseBubble && !parsed.actions?.length && !parsed.alerts?.length) {
          addMsg("Sem resposta", "boris");
        }
      } else {
        // Not JSON — show as plain text
        if (!responseBubble) {
          addMsg(resp.answer, "boris");
        }
      }
    } else if (!responseBubble) {
      addMsg("Sem resposta", "boris");
    }
  } catch (err) {
    clearTimeout(timeoutId);
    proc.remove();
    if (err.name === "AbortError") {
      if (askAborted) {
        addMsg("Timeout — tenta novamente", "error");
      } else {
        addMsg("Cancelado", "system");
      }
    } else {
      addMsg(`Error: ${err.message}`, "error");
    }
  }

  stopProcessingBar();
  setAskState(false);
}

// Try to extract JSON actions from a response string
function _tryParseActions(text) {
  try {
    const obj = JSON.parse(text);
    // Standard format: { actions: [...] }
    if (obj.actions) return obj;
    // Bare array of actions — wrap it
    if (Array.isArray(obj) && obj.length > 0) {
      const normalized = _normalizeActionArray(obj);
      if (normalized) return normalized;
    }
  } catch (_) {}
  const m = text.match(/\{[\s\S]*"actions"[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) {}
  }
  // Try to match a bare array
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const arr = JSON.parse(arrMatch[0]);
      if (Array.isArray(arr) && arr.length > 0) {
        const normalized = _normalizeActionArray(arr);
        if (normalized) return normalized;
      }
    } catch (_) {}
  }
  return null;
}

// Convert alternative action formats into the standard { actions, alerts, answer } shape
function _normalizeActionArray(arr) {
  if (!arr[0].field && !arr[0].type) return null;

  // Case: array of { field, action, value/old/new } — Claude's alternative format
  if (arr[0].field) {
    const alerts = [];
    const actions = arr.map((item) => {
      if (item.note) alerts.push(item.note);
      // Use name-based lookup (findElement handles CSS.escape)
      // Also try id for simple field names without dots
      const selector = item.field.includes(".")
        ? `[name="${item.field}"]`
        : `#${item.field}, [name="${item.field}"]`;

      if (item.action === "replace" && item.old != null) {
        return {
          type: "replace_text",
          selector,
          name: item.field,
          oldValue: item.old,
          value: item.new || item.value,
          description: item.description || item.note || `Substituir "${(item.old || "").substring(0, 40)}" → "${(item.new || item.value || "").substring(0, 40)}"`,
        };
      }
      // action: "fill" or any other — treat as fill_text
      return {
        type: "fill_text",
        selector,
        name: item.field,
        value: item.value,
        description: item.description || item.note || `Preencher ${item.field}`,
      };
    });
    return { actions, alerts, answer: `${actions.length} acções detectadas.` };
  }

  // Case: array of standard actions (type, selector, value...)
  if (arr[0].type && (arr[0].selector || arr[0].id || arr[0].name)) {
    return { actions: arr, alerts: [], answer: "" };
  }
  return null;
}

// Auto-grow textarea
function resetAskInput() {
  $askInput.value = "";
  $askInput.style.height = "28px";
}

$askInput.addEventListener("input", () => {
  $askInput.style.height = "28px";
  $askInput.style.height = Math.min($askInput.scrollHeight, 110) + "px";
});

$sendBtn.addEventListener("click", askBoris);
$askInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !askRunning) {
    e.preventDefault();
    askBoris();
  }
});

// ---------------------------------------------------------------------------
// Attach menu (+)
// ---------------------------------------------------------------------------
$attachBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $attachMenu.classList.toggle("open");
  $attachBtn.classList.toggle("open", open);
});

// Close menu on click outside
document.addEventListener("click", () => {
  $attachMenu.classList.remove("open");
  $attachBtn.classList.remove("open");
});

$attachMenu.addEventListener("click", (e) => e.stopPropagation());

// ---------------------------------------------------------------------------
// Screenshot (from attach menu) — stage only, send via askBoris
// ---------------------------------------------------------------------------
function clearPendingScreenshot() {
  pendingScreenshot = null;
  $attachPreviewImg.src = "";
  $attachPreviewImg.parentElement.classList.add("hidden");
  if (!pendingFormDesc) $attachPreview.classList.remove("visible");
}

$screenshotBtn.addEventListener("click", async () => {
  $attachMenu.classList.remove("open");
  $attachBtn.classList.remove("open");
  if (askRunning) return;

  try {
    const capture = await sendToBg({ action: "capture-tab" });
    if (capture.error) { addMsg(`Screenshot falhou: ${capture.error}`, "error"); return; }

    // Stage the screenshot
    pendingScreenshot = capture.dataUrl;
    $attachPreviewImg.src = capture.dataUrl;
    $attachPreviewImg.parentElement.classList.remove("hidden");
    $attachPreview.classList.add("visible");
    $askInput.focus();
  } catch (err) {
    addMsg(`Screenshot falhou: ${err.message}`, "error");
  }
});

$attachPreviewRemove.addEventListener("click", clearPendingScreenshot);

// ---------------------------------------------------------------------------
// Alert modal — shows alerts with a single OK button
// ---------------------------------------------------------------------------
function showAlertModal(alerts) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = "formdesc-modal";
    modal.innerHTML = `
      <div class="formdesc-modal-box" style="height:auto;max-height:70%;">
        <div class="formdesc-modal-header" style="color:var(--warning);">\u26a0 Alertas</div>
        <div class="formdesc-modal-body" style="flex:0 1 auto;"></div>
        <div class="formdesc-modal-footer">
          <button class="alert-modal-ok">OK</button>
        </div>
      </div>`;
    const body = modal.querySelector(".formdesc-modal-body");
    const ul = document.createElement("ul");
    ul.style.cssText = "list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px;";
    for (const a of alerts) {
      const li = document.createElement("li");
      li.style.cssText = "color:var(--text-secondary);font-size:13px;line-height:1.5;padding:8px 12px;background:rgba(251,191,36,0.08);border-left:3px solid var(--warning);border-radius:4px;";
      li.textContent = a;
      ul.appendChild(li);
    }
    body.appendChild(ul);
    const close = () => { modal.remove(); resolve(); };
    modal.querySelector(".alert-modal-ok").addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); document.removeEventListener("keydown", onKey); close(); }
    });
    document.body.appendChild(modal);
  });
}

// ---------------------------------------------------------------------------
// Describe Form Structure — scan all fields + force-load select options
// ---------------------------------------------------------------------------
function showFormDescModal(text, title) {
  if (!text) return;
  const modalTitle = title || (pendingFormDescMode === "validate" ? "Validate Form Data" : "Describe Form Data");
  const modal = document.createElement("div");
  modal.className = "formdesc-modal";
  modal.innerHTML = `
    <div class="formdesc-modal-box">
      <div class="formdesc-modal-header">${modalTitle}</div>
      <div class="formdesc-modal-body">
        <pre></pre>
      </div>
      <div class="formdesc-modal-footer">
        <button class="formdesc-modal-ok">OK</button>
      </div>
    </div>`;
  modal.querySelector("pre").textContent = text;
  modal.querySelector(".formdesc-modal-ok").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

// ---------------------------------------------------------------------------
// JSON Inspector — multi-action viewer with JSON and Tree tabs
// ---------------------------------------------------------------------------
function showJsonInspector(items, title) {
  if (!items || !items.length) return;

  const modal = document.createElement("div");
  modal.className = "formdesc-modal";
  modal.innerHTML = `
    <div class="formdesc-modal-box" style="max-width:600px;">
      <div class="formdesc-modal-header" style="display:flex;align-items:center;gap:8px;justify-content:space-between;">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;">${title}</span>
        <button class="ji-copy" title="Copiar" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;color:var(--text-secondary);">Copy</button>
      </div>
      <div style="display:flex;gap:6px;padding:0 16px;align-items:center;">
        <select class="ji-select" style="flex:1;padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:11px;background:var(--surface);color:var(--text);"></select>
        <div class="ji-tabs" style="display:flex;gap:2px;">
          <button class="ji-tab ji-tab-active" data-tab="json" style="padding:2px 10px;border:1px solid var(--border);border-radius:4px 4px 0 0;font-size:11px;cursor:pointer;background:var(--surface-2);color:var(--text);">JSON</button>
          <button class="ji-tab" data-tab="tree" style="padding:2px 10px;border:1px solid var(--border);border-radius:4px 4px 0 0;font-size:11px;cursor:pointer;background:var(--surface);color:var(--text-secondary);">Tree</button>
        </div>
      </div>
      <div class="formdesc-modal-body" style="flex:1 1 auto;padding:0 16px 8px;">
        <div class="ji-content-json" style="display:block;"><pre style="white-space:pre-wrap;word-break:break-all;font-size:11px;line-height:1.5;margin:0;"></pre></div>
        <div class="ji-content-tree" style="display:none;font-size:11px;line-height:1.6;"></div>
      </div>
      <div class="formdesc-modal-footer"><button class="formdesc-modal-ok">Fechar</button></div>
    </div>`;

  const select = modal.querySelector(".ji-select");
  const jsonPre = modal.querySelector(".ji-content-json pre");
  const treeDiv = modal.querySelector(".ji-content-tree");
  const jsonPanel = modal.querySelector(".ji-content-json");
  const treePanel = modal.querySelector(".ji-content-tree");
  let activeTab = "json";

  // Populate selector
  items.forEach((item, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    const status = item.status === "done" ? "\u2713" : item.status === "skipped" ? "\u23ed" : "\u2717";
    const desc = item.action?.description || item.description || `Action ${i + 1}`;
    opt.textContent = `#${i + 1} ${status} ${desc}`.slice(0, 80);
    select.appendChild(opt);
  });

  function renderItem(idx) {
    const item = items[idx];
    const json = JSON.stringify(item, null, 2);
    jsonPre.textContent = json;
    treeDiv.innerHTML = "";
    treeDiv.appendChild(_buildTree(item));
  }

  function setTab(tab) {
    activeTab = tab;
    jsonPanel.style.display = tab === "json" ? "block" : "none";
    treePanel.style.display = tab === "tree" ? "block" : "none";
    modal.querySelectorAll(".ji-tab").forEach((t) => {
      const isActive = t.dataset.tab === tab;
      t.classList.toggle("ji-tab-active", isActive);
      t.style.background = isActive ? "var(--surface-2)" : "var(--surface)";
      t.style.color = isActive ? "var(--text)" : "var(--text-secondary)";
    });
  }

  select.addEventListener("change", () => renderItem(parseInt(select.value)));
  modal.querySelectorAll(".ji-tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));

  modal.querySelector(".ji-copy").addEventListener("click", () => {
    const text = activeTab === "json" ? jsonPre.textContent : treeDiv.innerText;
    navigator.clipboard.writeText(text).then(() => {
      modal.querySelector(".ji-copy").textContent = "Copied!";
      setTimeout(() => { modal.querySelector(".ji-copy").textContent = "Copy"; }, 1500);
    });
  });

  modal.querySelector(".formdesc-modal-ok").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
  document.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); document.removeEventListener("keydown", onKey); modal.remove(); }
  });

  renderItem(0);
  document.body.appendChild(modal);
}

// Build collapsible tree view from a JS object
function _buildTree(obj, depth = 0) {
  const container = document.createElement("div");
  container.style.paddingLeft = depth > 0 ? "16px" : "0";

  if (obj === null || obj === undefined) {
    container.innerHTML = `<span style="color:var(--text-muted);">null</span>`;
    return container;
  }

  if (typeof obj !== "object") {
    const color = typeof obj === "string" ? "#22c55e" : typeof obj === "number" ? "#3b82f6" : "#f59e0b";
    const val = typeof obj === "string" ? `"${obj}"` : String(obj);
    container.innerHTML = `<span style="color:${color};word-break:break-all;">${val.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`;
    return container;
  }

  const isArray = Array.isArray(obj);
  const entries = isArray ? obj.map((v, i) => [i, v]) : Object.entries(obj);

  for (const [key, val] of entries) {
    const row = document.createElement("div");
    const isComplex = val !== null && typeof val === "object";
    const keyLabel = isArray ? `[${key}]` : key;

    if (isComplex) {
      const childCount = Array.isArray(val) ? val.length : Object.keys(val).length;
      const bracket = Array.isArray(val) ? `[${childCount}]` : `{${childCount}}`;
      row.innerHTML = `<span class="ji-toggle" style="cursor:pointer;user-select:none;">
        <span class="ji-arrow" style="display:inline-block;width:12px;font-size:10px;color:var(--text-muted);">\u25B6</span>
        <span style="color:var(--accent);font-weight:500;">${keyLabel}</span>
        <span style="color:var(--text-muted);font-size:10px;margin-left:4px;">${bracket}</span>
      </span>`;
      const child = _buildTree(val, depth + 1);
      child.style.display = "none";
      row.appendChild(child);

      row.querySelector(".ji-toggle").addEventListener("click", () => {
        const open = child.style.display !== "none";
        child.style.display = open ? "none" : "block";
        row.querySelector(".ji-arrow").textContent = open ? "\u25B6" : "\u25BC";
      });
    } else {
      row.innerHTML = `<span style="display:inline-block;width:12px;"></span><span style="color:var(--accent);font-weight:500;">${keyLabel}</span>: `;
      row.appendChild(_buildTree(val, depth + 1));
    }

    container.appendChild(row);
  }

  return container;
}

function clearPendingFormDesc() {
  pendingFormDesc = null;
  pendingFormDescMode = "structure";
  const el = document.querySelector(".attach-preview-formdesc");
  if (el) el.remove();
  if (!pendingScreenshot && !pendingAiGenerate) $attachPreview.classList.remove("visible");
}

// AI Generate — preview thumb (exposed on window for rpa-ui.js)
window._updateAiGenerateThumb = function _updateAiGenerateThumb() {
  const old = document.querySelector(".attach-preview-aigenerate");
  if (old) old.remove();
  if (!pendingAiGenerate) {
    if (!pendingScreenshot && !pendingFormDesc) $attachPreview.classList.remove("visible");
    return;
  }
  $attachPreview.classList.add("visible");
  const wrapper = document.createElement("div");
  wrapper.className = "attach-preview-inner attach-preview-aigenerate";
  wrapper.innerHTML = `
    <div class="attach-preview-doc" style="color:#a855f7;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/></svg>
      <span class="doc-label">AI Generate</span>
    </div>
    <button class="attach-preview-remove aigenerate-remove"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
  `;
  wrapper.querySelector(".aigenerate-remove").addEventListener("click", (e) => {
    e.stopPropagation();
    window.pendingAiGenerate = false;
    window._updateAiGenerateThumb();
  });
  $attachPreview.appendChild(wrapper);
  $askInput.focus();
}

document.getElementById("describeFormBtn").addEventListener("click", async () => {
  $attachMenu.classList.remove("open");
  $attachBtn.classList.remove("open");
  if (askRunning) return;

  const loading = addLoading("A descrever estrutura do formulário...");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { loading.remove(); addMsg("No active tab", "error"); return; }

    const data = await chrome.tabs.sendMessage(tab.id, { action: "describe-form-structure" });
    loading.remove();

    if (data.error) { addMsg(`Falhou: ${data.error}`, "error"); return; }
    if (!data.text) { addMsg("Nenhum campo encontrado nesta página.", "system"); return; }

    pendingFormDesc = data.text;
    pendingFormDescMode = "structure";
    _showFormDescPreview(data.fieldCount, "Describe Form Data");
  } catch (err) {
    loading.remove();
    if (err.message?.includes("Receiving end does not exist")) {
      addMsg("Content script não carregado. Recarrega a página (F5) e tenta novamente.", "error");
    } else {
      addMsg(`Falhou: ${err.message}`, "error");
    }
  }
});

// Stage form description from external modules (rpa-ui.js)
window.stageFormDesc = function(text, fieldCount, label) {
  pendingFormDesc = text;
  pendingFormDescMode = "structure";
  _showFormDescPreview(fieldCount, label);
};

// Helper: show form desc preview thumbnail
function _showFormDescPreview(fieldCount, label) {
  $attachPreview.classList.add("visible");
  const old = document.querySelector(".attach-preview-formdesc");
  if (old) old.remove();
  const wrapper = document.createElement("div");
  wrapper.className = "attach-preview-inner attach-preview-formdesc";
  wrapper.innerHTML = `
    <div class="attach-preview-doc">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>
      <span class="doc-label">${label}<br>(${fieldCount} campos)</span>
    </div>
    <button class="attach-preview-remove formdesc-remove"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
  `;
  wrapper.querySelector(".formdesc-remove").addEventListener("click", (e) => {
    e.stopPropagation();
    clearPendingFormDesc();
  });
  wrapper.querySelector(".attach-preview-doc").addEventListener("click", () => {
    showFormDescModal(pendingFormDesc);
  });
  $attachPreview.appendChild(wrapper);
  $askInput.focus();
}

// Validate Form Content — full content, no truncation
document.getElementById("validateFormBtn").addEventListener("click", async () => {
  $attachMenu.classList.remove("open");
  $attachBtn.classList.remove("open");
  if (askRunning) return;

  const loading = addLoading("A ler conteúdo completo do formulário...");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { loading.remove(); addMsg("No active tab", "error"); return; }

    const data = await chrome.tabs.sendMessage(tab.id, { action: "describe-form-full-content" });
    loading.remove();

    if (data.error) { addMsg(`Falhou: ${data.error}`, "error"); return; }
    if (!data.text) { addMsg("Nenhum campo encontrado nesta página.", "system"); return; }

    pendingFormDesc = data.text;
    pendingFormDescMode = "validate";
    _showFormDescPreview(data.fieldCount, "Validate Form Data");
  } catch (err) {
    loading.remove();
    if (err.message?.includes("Receiving end does not exist")) {
      addMsg("Content script não carregado. Recarrega a página (F5) e tenta novamente.", "error");
    } else {
      addMsg(`Falhou: ${err.message}`, "error");
    }
  }
});

// ---------------------------------------------------------------------------
// Header menu ("..." button)
// ---------------------------------------------------------------------------
$headerMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  $headerMenu.classList.toggle("open");
});

// Close menu on outside click
document.addEventListener("click", (e) => {
  if (!$headerMenu.contains(e.target) && e.target !== $headerMenuBtn) {
    $headerMenu.classList.remove("open");
  }
});

// Snapshot of settings values before editing (for cancel)
let _settingsSnapshot = {};

function openSettings() {
  $headerMenu.classList.remove("open");
  // Snapshot current values
  _settingsSnapshot = {
    timeout: $timeoutSelect.value,
    bridgeUrl: $bridgeUrlInput.value,
    permissions: $permissionsSelect.value,
    initialPrompt: $initialPrompt.value,
  };
  document.getElementById("settingsBackdrop").classList.add("open");
  $settingsPanel.classList.add("open");
}

function closeSettings() {
  document.getElementById("settingsBackdrop").classList.remove("open");
  $settingsPanel.classList.remove("open");
}

$settingsToggle.addEventListener("click", openSettings);
document.getElementById("settingsCloseBtn").addEventListener("click", () => {
  // Cancel — restore snapshot
  $timeoutSelect.value = _settingsSnapshot.timeout;
  $bridgeUrlInput.value = _settingsSnapshot.bridgeUrl;
  $permissionsSelect.value = _settingsSnapshot.permissions;
  $initialPrompt.value = _settingsSnapshot.initialPrompt;
  closeSettings();
});
document.getElementById("settingsBackdrop").addEventListener("click", () => {
  // Cancel on backdrop click
  $timeoutSelect.value = _settingsSnapshot.timeout;
  $bridgeUrlInput.value = _settingsSnapshot.bridgeUrl;
  $permissionsSelect.value = _settingsSnapshot.permissions;
  $initialPrompt.value = _settingsSnapshot.initialPrompt;
  closeSettings();
});
document.getElementById("settingsCancelBtn").addEventListener("click", () => {
  $timeoutSelect.value = _settingsSnapshot.timeout;
  $bridgeUrlInput.value = _settingsSnapshot.bridgeUrl;
  $permissionsSelect.value = _settingsSnapshot.permissions;
  $initialPrompt.value = _settingsSnapshot.initialPrompt;
  closeSettings();
});
document.getElementById("settingsSaveBtn").addEventListener("click", () => {
  // Save all settings
  const url = $bridgeUrlInput.value.trim().replace(/\/+$/, "") || "http://localhost:9090";
  BRIDGE_URL = url;
  $bridgeUrlInput.value = url;
  chrome.storage.local.set({ timeout: $timeoutSelect.value });
  chrome.storage.sync.set({ bridgeUrl: url, permissions: $permissionsSelect.value, initialPrompt: $initialPrompt.value });
  closeSettings();
});

// Prompt context menu
const $promptMenu = document.getElementById("promptMenu");
document.getElementById("promptMenuBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  $promptMenu.classList.toggle("open");
});
document.addEventListener("click", (e) => {
  if (!$promptMenu.contains(e.target)) $promptMenu.classList.remove("open");
});
document.getElementById("promptCopyBtn").addEventListener("click", () => {
  navigator.clipboard.writeText($initialPrompt.value);
  $promptMenu.classList.remove("open");
});
document.getElementById("promptPasteBtn").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    $initialPrompt.value = text;
  } catch (_) {}
  $promptMenu.classList.remove("open");
});
document.getElementById("promptRestoreBtn").addEventListener("click", () => {
  $initialPrompt.value = DEFAULT_INITIAL_PROMPT;
  $promptMenu.classList.remove("open");
});

$clearChatBtn.addEventListener("click", () => {
  $headerMenu.classList.remove("open");
  $chat.innerHTML = '<div class="msg system">Conversa limpa</div>';
});

// Settings tabs
document.querySelectorAll(".settings-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".settings-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".settings-tab-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`[data-tab-content="${tab.dataset.tab}"]`).classList.add("active");
  });
});

// Copy button on code blocks + screenshot expand
$chat.addEventListener("click", (e) => {
  // Copy button
  const btn = e.target.closest(".copy-btn");
  if (btn) {
    const pre = btn.closest("pre");
    if (!pre) return;
    // Use data-raw (original text before markdown transforms) or fall back to code.innerText
    let copyText;
    if (pre.dataset.raw) {
      try { copyText = decodeURIComponent(escape(atob(pre.dataset.raw))); } catch (_) {}
    }
    if (!copyText) {
      const code = pre.querySelector("code");
      copyText = code ? code.innerText : pre.innerText;
    }
    const origHTML = btn.innerHTML;
    navigator.clipboard.writeText(copyText).then(() => {
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      btn.classList.add("copied");
      setTimeout(() => {
        btn.innerHTML = origHTML;
        btn.classList.remove("copied");
      }, 1000);
    });
    return;
  }

  // Screenshot preview — expand to full size
  const img = e.target.closest(".screenshot-preview");
  if (img) {
    const overlay = document.createElement("div");
    overlay.className = "screenshot-overlay";
    overlay.innerHTML = `<img src="${img.src}">`;
    overlay.addEventListener("click", () => overlay.remove());
    document.body.appendChild(overlay);
  }
});

// ---------------------------------------------------------------------------
// Context menu — receive scanned select options from background
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "insert-field-options") {
    const pos = $askInput.selectionStart ?? $askInput.value.length;
    const before = $askInput.value.substring(0, pos);
    const after = $askInput.value.substring(pos);
    const separator = before && !before.endsWith("\n") ? "\n" : "";
    const inserted = separator + msg.text;
    $askInput.value = before + inserted + after;
    const newPos = pos + inserted.length;
    $askInput.selectionStart = newPos;
    $askInput.selectionEnd = newPos;
    $askInput.dispatchEvent(new Event("input"));
    $askInput.focus();
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
init();
