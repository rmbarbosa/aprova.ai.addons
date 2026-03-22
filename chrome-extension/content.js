/**
 * Aprova.ai Extension — Content Script
 * Scans form fields, executes fill actions, shows overlays.
 * Author: Rui Barbosa @rmblda 2026
 */

// Wrap everything — if extension context is dead, bail silently
(function () {

// Guard: bail out entirely if extension context is already dead (stale script)
let _runtime;
try { _runtime = chrome.runtime; } catch (_) { return; }
if (!_runtime?.id) return;
function _alive() { try { return !!_runtime?.id; } catch (_) { return false; } }

// ---------------------------------------------------------------------------
// DOM Scanning
// ---------------------------------------------------------------------------

function buildUniqueSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.name) {
    const byName = document.querySelectorAll(`[name="${CSS.escape(el.name)}"]`);
    if (byName.length === 1) return `[name="${CSS.escape(el.name)}"]`;
  }
  // Fallback: build path
  const parts = [];
  let current = el;
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector = `#${CSS.escape(current.id)}`;
      parts.unshift(selector);
      break;
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter(
        (c) => c.tagName === current.tagName
      );
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(selector);
    current = parent;
  }
  return parts.join(" > ");
}

function extractPageNumber() {
  // Try common pagination patterns
  const pagers = document.querySelectorAll(
    ".pagination .active, .page-item.active, .step.active, [aria-current='page']"
  );
  for (const p of pagers) {
    const num = parseInt(p.textContent.trim());
    if (!isNaN(num)) return num;
  }
  // Try URL
  const m = location.href.match(/[?&](?:page|step|passo)=(\d+)/i);
  if (m) return parseInt(m[1]);
  return null;
}

function scanPage() {
  // Fields
  const fields = [];
  document.querySelectorAll("input, textarea, select").forEach((el) => {
    if (el.offsetParent === null && el.type !== "hidden") return;
    const label = el.id
      ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      : null;
    // Also try closest label
    const closestLabel = el.closest("label");

    fields.push({
      id: el.id || el.name || null,
      name: el.name || null,
      type: el.type || el.tagName.toLowerCase(),
      label:
        label?.textContent?.trim() ||
        closestLabel?.textContent?.trim() ||
        el.placeholder ||
        el.getAttribute("aria-label") ||
        "",
      currentValue: el.type === "checkbox" || el.type === "radio" ? String(el.checked) : el.value,
      checked: el.checked || false,
      maxLength: el.maxLength > 0 ? el.maxLength : null,
      required: el.required || el.getAttribute("aria-required") === "true",
      disabled: el.disabled,
      selector: buildUniqueSelector(el),
      options:
        el.tagName === "SELECT"
          ? [...el.options].map((o) => ({
              value: o.value,
              text: o.text,
              selected: o.selected,
            }))
          : null,
    });
  });

  // Buttons
  const buttons = [];
  document
    .querySelectorAll('button, input[type="submit"], a.btn, [role="button"]')
    .forEach((el) => {
      if (el.offsetParent === null) return;
      buttons.push({
        id: el.id || null,
        text: el.textContent?.trim(),
        type: el.type || "button",
        selector: buildUniqueSelector(el),
        disabled: el.disabled || false,
      });
    });

  // Page context
  const pageContext = {
    title: document.title,
    url: location.href,
    breadcrumb:
      document.querySelector(".breadcrumb, nav[aria-label]")?.textContent?.trim() || null,
    activeTab:
      document.querySelector(".nav-link.active, .tab.active, .nav-tabs .active")
        ?.textContent?.trim() || null,
    pageNumber: extractPageNumber(),
    headings: [...document.querySelectorAll("h1, h2, h3")]
      .slice(0, 5)
      .map((h) => h.textContent.trim()),
  };

  return { fields, buttons, pageContext };
}

// ---------------------------------------------------------------------------
// Element finding
// ---------------------------------------------------------------------------

function findElement(action) {
  // Try selector first
  if (action.selector) {
    try {
      const el = document.querySelector(action.selector);
      if (el) return el;
    } catch (e) {
      // Invalid selector, fall through
    }
  }
  // Try by id
  if (action.id) {
    const el = document.getElementById(action.id);
    if (el) return el;
  }
  // Try by name
  if (action.name) {
    const el = document.querySelector(`[name="${CSS.escape(action.name)}"]`);
    if (el) return el;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

function highlightElement(el, actionType) {
  const colors = {
    fill_text: "#4CAF50",
    select_option: "#2196F3",
    click_radio: "#FF9800",
    click_checkbox: "#FF9800",
    click_button: "#9C27B0",
  };
  const color = colors[actionType] || "#4CAF50";
  el.style.outline = `2px solid ${color}`;
  el.style.outlineOffset = "1px";
  // Add tooltip
  el.setAttribute("title", `[Aprova.ai] ${actionType}`);
  // Remove highlight after 10s
  setTimeout(() => {
    el.style.outline = "";
    el.style.outlineOffset = "";
  }, 10000);
}

function showConfirmOverlay(action) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "aprova-confirm-overlay";

    const labels = {
      fill_text: "Preencher texto",
      select_option: "Seleccionar opção",
      click_radio: "Seleccionar radio",
      click_checkbox: "Marcar checkbox",
      click_button: "Clicar botão",
      wait: "Esperar",
      scroll_to: "Scroll",
    };

    const target = findElement(action);

    overlay.innerHTML = `
      <div class="aprova-confirm-box">
        <div class="aprova-confirm-type">${labels[action.type] || action.type}</div>
        <div class="aprova-confirm-desc">${action.description || action.selector || ""}</div>
        ${action.value ? '<textarea class="aprova-confirm-value" readonly></textarea>' : ""}
        <div class="aprova-confirm-buttons">
          <button class="aprova-btn aprova-btn-yes">OK</button>
          <button class="aprova-btn aprova-btn-skip">Skip</button>
          <button class="aprova-btn aprova-btn-stop">Stop</button>
        </div>
      </div>`;

    // Set value via property (not innerHTML) to avoid HTML injection
    const valueEl = overlay.querySelector(".aprova-confirm-value");
    if (valueEl) {
      valueEl.value = action.value;
    }

    function dismiss(result) {
      overlay.remove();
      if (target) target.style.outline = "";
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }

    overlay.querySelector(".aprova-btn-yes").onclick = () => dismiss(true);
    overlay.querySelector(".aprova-btn-skip").onclick = () => dismiss(false);
    overlay.querySelector(".aprova-btn-stop").onclick = () => dismiss("stop");

    // Keyboard shortcuts: Enter=OK, Escape=Skip, Shift+Escape=Stop
    function onKey(e) {
      if (e.key === "Enter") { e.preventDefault(); dismiss(true); }
      else if (e.key === "Escape" && e.shiftKey) { e.preventDefault(); dismiss("stop"); }
      else if (e.key === "Escape") { e.preventDefault(); dismiss(false); }
    }
    document.addEventListener("keydown", onKey);

    // Highlight target element
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.style.outline = "3px solid #FF9800";
    }

    document.body.appendChild(overlay);
  });
}

async function executeAction(action, confirmMode) {
  if (confirmMode) {
    const approved = await showConfirmOverlay(action);
    if (approved === "stop") return { status: "stopped", action };
    if (!approved) return { status: "skipped", action };
  }

  if (action.type === "wait") {
    await new Promise((r) => setTimeout(r, action.ms || 1000));
    return { status: "done", action };
  }

  if (action.type === "scroll_to") {
    const el = findElement(action);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    return { status: el ? "done" : "not_found", action };
  }

  const el = findElement(action);
  if (!el) return { status: "not_found", action };

  switch (action.type) {
    case "fill_text": {
      // Focus, clear, set value, dispatch events
      el.focus();
      el.value = action.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      break;
    }
    case "select_option": {
      el.value = action.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      break;
    }
    case "click_radio":
    case "click_checkbox": {
      el.checked = action.value !== false && action.value !== "false";
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.click();
      break;
    }
    case "click_button": {
      el.click();
      break;
    }
  }

  highlightElement(el, action.type);
  return { status: "done", action };
}

async function executeActions(actions, confirmMode) {
  const results = [];
  for (const action of actions) {
    const result = await executeAction(action, confirmMode);
    results.push(result);
    if (result.status === "stopped") break;
    if (result.status === "not_found") {
      // Log but continue with remaining actions
      console.warn("[Aprova.ai] Element not found:", action);
    }
    // Visual pause between actions
    await new Promise((r) => setTimeout(r, 200));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Message handler — from background/popup
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Context menu support — track the right-clicked element
// ---------------------------------------------------------------------------
let lastContextTarget = null;
document.addEventListener("contextmenu", (e) => {
  if (_alive()) lastContextTarget = e.target;
});

_runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!_alive()) { sendResponse({ error: "extension context invalidated" }); return; }
    switch (msg.action) {
      case "scan-page":
        sendResponse(scanPage());
        break;

      case "execute-actions":
        const results = await executeActions(
          msg.actions || [],
          msg.confirmMode !== false
        );
        sendResponse({ results });
        break;

      case "scan-select-options": {
        // Try to find a select near the right-clicked element
        const el = lastContextTarget;
        lastContextTarget = null;
        let selects = [];
        let directSelect = null;
        try { directSelect = el?.closest?.("select") || el?.querySelector?.("select"); } catch (_) {}
        if (directSelect) {
          selects = [directSelect];
        } else {
          // Scan all visible selects on the page
          selects = [...document.querySelectorAll("select")].filter(
            (s) => s.offsetParent !== null && s.options.length > 0
          );
        }
        if (selects.length === 0) {
          sendResponse({ error: "no-select" });
          break;
        }
        const result = selects.map((select) => {
          const lbl = select.id
            ? document.querySelector(`label[for="${CSS.escape(select.id)}"]`)?.textContent?.trim()
            : null;
          const closestLbl = select.closest("label")?.textContent?.trim();
          const options = [...select.options]
            .filter((o) => o.value)
            .map((o) => ({ value: o.value, text: o.text.trim() }));

          // Detect table context — column header
          let columnHeader = null;
          const td = select.closest("td, th");
          if (td) {
            const row = td.parentElement;
            const colIdx = [...row.children].indexOf(td);
            const table = td.closest("table");
            if (table && colIdx >= 0) {
              const headerRow = table.querySelector("thead tr") || table.querySelector("tr");
              if (headerRow) {
                const th = headerRow.children[colIdx];
                if (th) columnHeader = th.textContent.trim();
              }
            }
          }

          return {
            label: lbl || closestLbl || select.name || select.id || "",
            name: select.name || null,
            selector: buildUniqueSelector(select),
            currentValue: select.value,
            columnHeader,
            options,
          };
        });
        sendResponse(result.length === 1 ? result[0] : { fields: result });
        break;
      }

      case "describe-form-full-content":
      case "describe-form-structure": {
        const _fullContent = msg.action === "describe-form-full-content";
        // Walk form fields left-to-right (DOM order).
        // "Validate Form Content" uses strict visibility — only truly visible fields
        // (excludes hidden tabs, collapsed sections, display:none ancestors).
        // "Describe Form Structure" includes anything with offsetParent (looser).
        function _isStrictlyVisible(el) {
          if (el.type === "hidden") return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return false;
          let node = el;
          while (node && node !== document.body) {
            const style = getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden") return false;
            node = node.parentElement;
          }
          return true;
        }

        const allFields = [...document.querySelectorAll("input, textarea, select")]
          .filter((el) => _isStrictlyVisible(el));

        const lines = [];
        lines.push(`Página: ${document.title}`);
        lines.push(`URL: ${location.href}`);
        const headings = [...document.querySelectorAll("h1, h2, h3")].slice(0, 5).map((h) => h.textContent.trim());
        if (headings.length) lines.push(`Secções: ${headings.join(" > ")}`);
        lines.push("");

        // Helper: get column headers for a table
        function getTableHeaders(table) {
          const headerRow = table.querySelector("thead tr") || table.querySelector("tr");
          if (!headerRow) return [];
          return [...headerRow.children].map((th) => th.textContent.trim());
        }

        // Helper: get row number (1-based, skipping header)
        function getRowIndex(tr) {
          const tbody = tr.closest("tbody") || tr.closest("table");
          const rows = [...tbody.querySelectorAll("tr")];
          // Skip header rows
          const dataRows = rows.filter((r) => !r.closest("thead") && r.querySelector("td"));
          return dataRows.indexOf(tr) + 1;
        }

        // Helper: describe a single field
        async function describeField(el, indent = "") {
          const lbl = el.id
            ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim()
            : null;
          const closestLbl = el.closest("label")?.textContent?.trim();
          const label = lbl || closestLbl || el.placeholder || el.getAttribute("aria-label") || el.name || el.id || "(sem label)";
          const req = el.required || el.getAttribute("aria-required") === "true" ? " *" : "";
          const state = el.disabled ? " [DISABLED]" : el.readOnly ? " [READONLY]" : "";

          // Column context for table fields
          let colPrefix = "";
          const td = el.closest("td, th");
          if (td) {
            const row = td.parentElement;
            const colIdx = [...row.children].indexOf(td);
            const table = td.closest("table");
            const headers = table ? getTableHeaders(table) : [];
            if (headers[colIdx]) colPrefix = `${headers[colIdx]}: `;
          }

          const fieldLines = [];

          if (el.tagName === "SELECT") {
            try {
              el.focus();
              el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
              await new Promise((r) => setTimeout(r, 150));
              el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
              el.blur();
            } catch (_) {}

            const opts = [...el.options]
              .filter((o) => o.value)
              .map((o) => o.text.trim())
              .filter((t) => t);
            const current = el.options[el.selectedIndex]?.text?.trim() || "";
            if (opts.length > 0) {
              fieldLines.push(`${indent}[SELECT${req}]${state} ${colPrefix}${label} (actual: "${current}")`);
              fieldLines.push(`${indent}  Opções: ${opts.join(" | ")}`);
            } else {
              fieldLines.push(`${indent}[SELECT${req}]${state} ${colPrefix}${label} (actual: "${current}") — sem opções carregadas`);
            }
          } else if (el.type === "radio") {
            fieldLines.push(`${indent}[RADIO${req}]${state} ${colPrefix}${label} — ${el.checked ? "seleccionado" : "não seleccionado"} (value: "${el.value}")`);
          } else if (el.type === "checkbox") {
            fieldLines.push(`${indent}[CHECKBOX${req}]${state} ${colPrefix}${label} — ${el.checked ? "marcado" : "desmarcado"}`);
          } else if (el.type === "hidden") {
            // skip
          } else if (el.tagName === "TEXTAREA") {
            const val = el.value
              ? (_fullContent ? `"${el.value}"` : `"${el.value.substring(0, 80)}${el.value.length > 80 ? "..." : ""}"`)
              : "(vazio)";
            const ml = el.maxLength > 0 ? ` [max: ${el.maxLength}]` : "";
            fieldLines.push(`${indent}[TEXTAREA${req}]${state} ${colPrefix}${label}${ml} — ${val}`);
          } else {
            const val = el.value ? `"${el.value}"` : "(vazio)";
            const ml = el.maxLength > 0 ? ` [max: ${el.maxLength}]` : "";
            fieldLines.push(`${indent}[${el.type.toUpperCase()}${req}]${state} ${colPrefix}${label}${ml} — ${val}`);
          }
          return fieldLines;
        }

        // Group fields: track which table we're inside
        let currentTable = null;
        let currentRow = null;

        for (const el of allFields) {
          const table = el.closest("table");
          const tr = el.closest("tr");

          if (table && table !== currentTable) {
            // Entering a new table
            if (currentTable) lines.push(""); // close previous table
            currentTable = table;
            currentRow = null;
            // Table caption or summary
            const caption = table.querySelector("caption")?.textContent?.trim();
            const headers = getTableHeaders(table);
            const tableLabel = caption || table.getAttribute("aria-label") || table.id || "";
            lines.push(`── Tabela${tableLabel ? ": " + tableLabel : ""} ──`);
            if (headers.length) lines.push(`  Colunas: ${headers.join(" | ")}`);
          } else if (!table && currentTable) {
            // Leaving a table
            lines.push(`── Fim Tabela ──`);
            lines.push("");
            currentTable = null;
            currentRow = null;
          }

          if (table && tr && tr !== currentRow) {
            currentRow = tr;
            const rowIdx = getRowIndex(tr);
            // Get first cell text as row identifier if available
            const firstCell = tr.querySelector("td");
            const rowLabel = firstCell?.textContent?.trim()?.substring(0, 50) || "";
            lines.push(`  Linha ${rowIdx}${rowLabel ? ": " + rowLabel : ""}`);
          }

          const indent = table ? "    " : "";
          const fieldLines = await describeField(el, indent);
          lines.push(...fieldLines);
        }

        if (currentTable) {
          lines.push(`── Fim Tabela ──`);
        }

        sendResponse({ text: lines.join("\n"), fieldCount: allFields.length });
        break;
      }

      case "ping":
        sendResponse({ ok: true });
        break;

      case "activate-push":
        _startPushState();
        sendResponse({ ok: true });
        break;

      case "deactivate-push":
        _stopPushState();
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ error: `Unknown content action: ${msg.action}` });
    }
  })();
  return true;
});

// ---------------------------------------------------------------------------
// Push state — only activated on demand by popup/background
// ---------------------------------------------------------------------------

let _pushHeartbeatId = null;
let _pushTimer = null;
let _pushObserver = null;
let _pushActive = false;

function _pushState() {
  if (!_alive()) { _stopPushState(); return; }
  try {
    _runtime.sendMessage({
      action: "push-page-state",
      pageScan: scanPage(),
      url: location.href,
      title: document.title,
    });
  } catch (_) { _stopPushState(); }
}

function _startPushState() {
  if (_pushActive) return;
  _pushActive = true;

  _pushState();

  window.addEventListener("popstate", _pushState);
  window.addEventListener("hashchange", _pushState);

  _pushObserver = new MutationObserver(() => {
    clearTimeout(_pushTimer);
    _pushTimer = setTimeout(_pushState, 2000);
  });
  _pushObserver.observe(document.body, { childList: true, subtree: true });

  _pushHeartbeatId = setInterval(_pushState, 30000);
}

function _stopPushState() {
  if (!_pushActive) return;
  _pushActive = false;

  window.removeEventListener("popstate", _pushState);
  window.removeEventListener("hashchange", _pushState);
  if (_pushHeartbeatId) { clearInterval(_pushHeartbeatId); _pushHeartbeatId = null; }
  if (_pushTimer) { clearTimeout(_pushTimer); _pushTimer = null; }
  if (_pushObserver) { _pushObserver.disconnect(); _pushObserver = null; }
}

})();
