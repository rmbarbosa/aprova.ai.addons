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
const $btnScan = document.getElementById("btnScan");
const $btnFill = document.getElementById("btnFill");
const $btnValidate = document.getElementById("btnValidate");
const $settingsToggle = document.getElementById("settingsToggle");
const $settingsPanel = document.getElementById("settingsPanel");
const $confirmMode = document.getElementById("confirmMode");
const $disconnectBtn = document.getElementById("disconnectBtn");
const $clearChatBtn = document.getElementById("clearChatBtn");
const $screenshotBtn = document.getElementById("screenshotBtn");
const $attachBtn = document.getElementById("attachBtn");
const $attachMenu = document.getElementById("attachMenu");
const $attachPreview = document.getElementById("attachPreview");
const $attachPreviewImg = document.getElementById("attachPreviewImg");
const $attachPreviewRemove = document.getElementById("attachPreviewRemove");

let pendingScreenshot = null; // data URL of staged screenshot
let pendingFormDesc = null; // staged form structure description text

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
function addMsg(text, type = "boris") {
  const div = document.createElement("div");
  div.className = `msg ${type}`;
  if (type === "boris") {
    div.innerHTML = renderMd(text);
  } else {
    div.textContent = text;
  }
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

const BRIDGE_URL = "http://localhost:9090";

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

  const resp = await sendToBg({ action: "session-start", project });

  $lobbyConnectBtn.textContent = "Iniciar Sessão";

  if (resp.error) {
    showLobbyError(`Falha: ${resp.error}`);
    $status.className = "status-dot";
    updateLobbyButton();
    return;
  }

  // Success — switch to connected screen
  $project.value = project;
  chrome.storage.local.set({ project, confirmMode: $confirmMode.checked });

  showScreen("connected");
  renderSteps(resp.steps);
  addMsg(resp.message || "Sessão ligada", "boris");
});

// ---------------------------------------------------------------------------
// Init — check bridge status, decide which screen to show
// ---------------------------------------------------------------------------
async function init() {
  // Load saved preferences
  const saved = await chrome.storage.local.get(["project", "confirmMode"]);
  if (saved.project) {
    $project.value = saved.project;
    $lobbyProject.value = saved.project;
  }
  if (saved.confirmMode !== undefined) $confirmMode.checked = saved.confirmMode;

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
  const resp = await sendToBg({
    action: "session-end",
    project: $project.value,
  });
  showScreen("lobby");
  $settingsPanel.classList.remove("open");
  // Refresh session list
  await loadSessionList();
  updateLobbyButton();
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
    if (err.message.includes("Receiving end does not exist")) {
      addMsg("Content script não carregado. Recarrega a página (F5) e tenta novamente.", "error");
    } else {
      addMsg(`Scan failed: ${err.message}`, "error");
    }
  }
});

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------
$btnFill.addEventListener("click", async () => {
  addMsg("Fill Page", "user");
  const proc = addProcessing("A analisar formulário...");

  const resp = await sendToBg({
    action: "fill",
    project: $project.value,
    confirmMode: $confirmMode.checked,
  });

  proc.remove();
  renderSteps(resp.steps);

  if (resp.error) {
    if (resp.error.includes("Receiving end does not exist")) {
      addMsg("Content script não carregado. Recarrega a página (F5) e tenta novamente.", "error");
    } else {
      addMsg(`Fill failed: ${resp.error}`, "error");
    }
    return;
  }

  if (resp.alerts?.length) {
    resp.alerts.forEach((a) => addMsg(`\u26a0 ${a}`, "error"));
  }

  if (resp.execution?.results) {
    const results = resp.execution.results;
    const done = results.filter((r) => r.status === "done").length;
    const total = results.length;
    addActionCard("Fill completed", results, `${done}/${total} fields`);
  } else if (resp.actions) {
    addMsg(`${resp.actions.length} actions ready — sending to page...`, "boris");
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
  const proc = addProcessing("A validar...");

  const resp = await sendToBg({
    action: "validate",
    project: $project.value,
  });

  proc.remove();
  renderSteps(resp.steps);

  if (resp.error) {
    if (resp.error.includes("Receiving end does not exist")) {
      addMsg("Content script não carregado. Recarrega a página (F5) e tenta novamente.", "error");
    } else {
      addMsg(`Validation failed: ${resp.error}`, "error");
    }
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
// Ask Boris (smart — includes page context when relevant)
// ---------------------------------------------------------------------------
const FILL_KEYWORDS = /\b(preench|fill|preenche|completa|submete|submit|envia|send|clica|click|seleccion|select|marca|check|form|campo|field|valor|value|página|page)\b/i;

async function tryGetPageScan() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    return await chrome.tabs.sendMessage(tab.id, { action: "scan-page" });
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
  if (!question && !hasScreenshot && !hasFormDesc) return;

  // Build the chat bubble — attachments on top, text below
  const defaultPrompt = hasFormDesc
    ? "Estrutura do formulário em anexo. Indica a melhor opção para cada campo de selecção."
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
  clearPendingScreenshot();
  clearPendingFormDesc();
  resetAskInput();
  askAborted = false;
  setAskState(true);

  // Attach page scan when relevant or when screenshot/formDesc is present
  const isPageRelated = FILL_KEYWORDS.test(msgText) || screenshotData || formDescData;
  let pageScan = null;

  if (isPageRelated && !formDescData) {
    const scanLoading = addLoading("A ler a página...");
    pageScan = await tryGetPageScan();
    scanLoading.remove();
    if (askAborted) { setAskState(false); addMsg("Cancelado", "system"); return; }
  }

  // Append form description to question if attached
  let fullQuestion = msgText;
  if (formDescData) {
    fullQuestion += "\n\nEstrutura do formulário nesta página:\n" + formDescData;
  }

  const proc = addProcessing(
    screenshotData ? "A analisar screenshot..." :
    formDescData ? "A analisar estrutura do formulário..." :
    "A pensar..."
  );

  // Create an AbortController so Stop button can cancel the stream
  const abortCtrl = new AbortController();
  const origAbortCheck = () => { if (askAborted) abortCtrl.abort(); };

  // Live response bubble — updates progressively
  let responseBubble = null;

  try {
    const resp = await streamAsk(
      {
        project: $project.value,
        question: fullQuestion,
        pageScan,
        screenshot: screenshotData || undefined,
      },
      {
        onStep: (text) => {
          // Show step messages above the response
          const stepDiv = document.createElement("div");
          stepDiv.className = "msg step";
          stepDiv.textContent = text;
          $chat.appendChild(stepDiv);
          $chat.scrollTop = $chat.scrollHeight;
        },
        onText: (fullText) => {
          proc.remove();
          origAbortCheck();
          if (!responseBubble) {
            responseBubble = document.createElement("div");
            responseBubble.className = "msg boris";
            $chat.appendChild(responseBubble);
          }
          responseBubble.innerHTML = renderMd(fullText);
          $chat.scrollTop = $chat.scrollHeight;
        },
        signal: abortCtrl.signal,
      }
    );

    proc.remove();

    if (askAborted) {
      setAskState(false);
      addMsg("Cancelado", "system");
      return;
    }

    if (resp.error) {
      addMsg(`Error: ${resp.error}`, "error");
      setAskState(false);
      return;
    }

    // If response contains JSON actions, try to parse and execute
    if (resp.answer && pageScan) {
      const parsed = _tryParseActions(resp.answer);
      if (parsed?.actions?.length > 0 && !askAborted) {
        addMsg(`${parsed.actions.length} acções detectadas — a executar...`, "boris");
        const execResp = await sendToBg({
          action: "execute-actions-on-page",
          actions: parsed.actions,
          confirmMode: $confirmMode.checked,
        });
        if (execResp.results) {
          const done = execResp.results.filter((r) => r.status === "done").length;
          addActionCard("Acções executadas", execResp.results, `${done}/${execResp.results.length}`);
        }
      }
    }

    // If no text was streamed, show the final answer
    if (!responseBubble && resp.answer) {
      addMsg(resp.answer, "boris");
    } else if (!responseBubble) {
      addMsg("Sem resposta", "boris");
    }
  } catch (err) {
    proc.remove();
    if (err.name === "AbortError") {
      addMsg("Cancelado", "system");
    } else {
      addMsg(`Error: ${err.message}`, "error");
    }
  }

  setAskState(false);
}

// Try to extract JSON actions from a response string
function _tryParseActions(text) {
  try {
    const obj = JSON.parse(text);
    if (obj.actions) return obj;
  } catch (_) {}
  const m = text.match(/\{[\s\S]*"actions"[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) {}
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
  $attachPreview.classList.remove("visible");
  $attachPreviewImg.src = "";
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
    $attachPreview.classList.add("visible");
    $askInput.focus();
  } catch (err) {
    addMsg(`Screenshot falhou: ${err.message}`, "error");
  }
});

$attachPreviewRemove.addEventListener("click", clearPendingScreenshot);

// Page title — insert at cursor position
document.getElementById("pageTitleBtn").addEventListener("click", async () => {
  $attachMenu.classList.remove("open");
  $attachBtn.classList.remove("open");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.title) return;
    const title = `[${tab.title}]`;
    const pos = $askInput.selectionStart || $askInput.value.length;
    const before = $askInput.value.substring(0, pos);
    const after = $askInput.value.substring(pos);
    $askInput.value = before + title + after;
    $askInput.selectionStart = $askInput.selectionEnd = pos + title.length;
    $askInput.dispatchEvent(new Event("input"));
    $askInput.focus();
  } catch (err) {
    addMsg(`Falhou: ${err.message}`, "error");
  }
});

// ---------------------------------------------------------------------------
// Describe Form Structure — scan all fields + force-load select options
// ---------------------------------------------------------------------------
function clearPendingFormDesc() {
  pendingFormDesc = null;
  const el = document.querySelector(".attach-preview-formdesc");
  if (el) el.remove();
  if (!pendingScreenshot) $attachPreview.classList.remove("visible");
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

    // Show doc thumbnail in preview area
    $attachPreview.classList.add("visible");
    const old = document.querySelector(".attach-preview-formdesc");
    if (old) old.remove();
    const wrapper = document.createElement("div");
    wrapper.className = "attach-preview-inner attach-preview-formdesc";
    wrapper.innerHTML = `
      <div class="attach-preview-doc">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>
        <span class="doc-label">form structure<br>(${data.fieldCount} campos)</span>
      </div>
      <button class="attach-preview-remove formdesc-remove"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    `;
    wrapper.querySelector(".formdesc-remove").addEventListener("click", clearPendingFormDesc);
    // Insert after the screenshot preview
    $attachPreview.appendChild(wrapper);
    $askInput.focus();
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
// Settings toggle
// ---------------------------------------------------------------------------
$settingsToggle.addEventListener("click", () => {
  $settingsPanel.classList.toggle("open");
});

$confirmMode.addEventListener("change", () => {
  chrome.storage.local.set({ confirmMode: $confirmMode.checked });
});

$clearChatBtn.addEventListener("click", () => {
  $chat.innerHTML = '<div class="msg system">Conversa limpa</div>';
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
