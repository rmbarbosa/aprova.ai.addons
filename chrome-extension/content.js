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
  // Try by id (exact)
  if (action.id) {
    const el = document.getElementById(action.id);
    if (el) return el;
  }
  // Try by name (exact)
  if (action.name) {
    try {
      const el = document.querySelector(`[name="${CSS.escape(action.name)}"]`);
      if (el) return el;
    } catch (_) {}
  }
  // Try name/id as a flexible lookup — handles dotted field names from Claude
  const fieldName = action.name || action.id || "";
  if (fieldName) {
    // Try id directly (getElementById handles dots naturally)
    const byId = document.getElementById(fieldName);
    if (byId) return byId;
    // Try name attribute without CSS.escape (some pages use dots in name)
    try {
      const byName = document.querySelector(`[name="${fieldName}"]`);
      if (byName) return byName;
    } catch (_) {}
    // Try partial match on id/name ending (e.g., "tbTexto3" matches "#prefix_tbTexto3")
    const lastPart = fieldName.includes(".") ? fieldName.split(".").pop() : "";
    if (lastPart) {
      const byPartialId = document.querySelector(`[id$="${CSS.escape(lastPart)}"]`);
      if (byPartialId) return byPartialId;
      const byPartialName = document.querySelector(`[name$="${CSS.escape(lastPart)}"]`);
      if (byPartialName) return byPartialName;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Robust text replacement — tries multiple strategies to find and replace
// Returns { result: string, success: bool, strategy: string }
// ---------------------------------------------------------------------------
function robustReplace(fieldValue, searchText, replaceText) {
  if (!searchText) return { result: fieldValue, success: false, strategy: "empty" };

  // Strategy 1: Exact match
  if (fieldValue.includes(searchText)) {
    return { result: fieldValue.replace(searchText, replaceText), success: true, strategy: "exact" };
  }

  // Strategy 2: Decode HTML entities in search text
  const decoded = searchText
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  if (decoded !== searchText && fieldValue.includes(decoded)) {
    return { result: fieldValue.replace(decoded, replaceText), success: true, strategy: "html-decode" };
  }

  // Strategy 3: Normalize unicode quotes/dashes in both
  const normalizeChars = (s) => s
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00A0/g, " ");
  const normSearch = normalizeChars(decoded);
  const normField = normalizeChars(fieldValue);
  if (normField.includes(normSearch)) {
    const idx = normField.indexOf(normSearch);
    return {
      result: fieldValue.substring(0, idx) + replaceText + fieldValue.substring(idx + normSearch.length),
      success: true,
      strategy: "unicode-normalize",
    };
  }

  // Strategy 4: Collapse whitespace (spaces, tabs, newlines → single space)
  const collapseWS = (s) => normalizeChars(s).replace(/\s+/g, " ").trim();
  const wsSearch = collapseWS(decoded);
  const wsField = collapseWS(fieldValue);
  if (wsField.includes(wsSearch)) {
    // Map collapsed positions back to original
    const idx = wsField.indexOf(wsSearch);
    let origStart = -1, origEnd = -1;
    let collapsed = 0, inWS = false;
    for (let i = 0; i < fieldValue.length; i++) {
      const ch = fieldValue[i];
      const isWS = /\s/.test(ch);
      if (isWS && inWS) continue; // skip consecutive whitespace
      if (collapsed === idx && origStart === -1) origStart = i;
      if (collapsed === idx + wsSearch.length) { origEnd = i; break; }
      collapsed++;
      inWS = isWS;
    }
    if (origStart >= 0) {
      if (origEnd < 0) origEnd = fieldValue.length;
      return {
        result: fieldValue.substring(0, origStart) + replaceText + fieldValue.substring(origEnd),
        success: true,
        strategy: "whitespace-collapse",
      };
    }
  }

  // Strategy 5: Case-insensitive match
  const escRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ciRegex = new RegExp(escRegex(wsSearch), "i");
  const ciMatch = wsField.match(ciRegex);
  if (ciMatch) {
    // Find in original using same collapsed mapping
    const ciFieldRegex = new RegExp(escRegex(collapseWS(decoded)), "i");
    const origMatch = collapseWS(fieldValue).match(ciFieldRegex);
    if (origMatch) {
      const idx = origMatch.index;
      let origStart = -1, origEnd = -1, collapsed = 0, inWS = false;
      for (let i = 0; i < fieldValue.length; i++) {
        const isWS = /\s/.test(fieldValue[i]);
        if (isWS && inWS) continue;
        if (collapsed === idx && origStart === -1) origStart = i;
        if (collapsed === idx + origMatch[0].length) { origEnd = i; break; }
        collapsed++;
        inWS = isWS;
      }
      if (origStart >= 0) {
        if (origEnd < 0) origEnd = fieldValue.length;
        return {
          result: fieldValue.substring(0, origStart) + replaceText + fieldValue.substring(origEnd),
          success: true,
          strategy: "case-insensitive",
        };
      }
    }
  }

  return { result: fieldValue, success: false, strategy: "none" };
}

function highlightElement(el, actionType) {
  const colors = {
    fill_text: "#4CAF50",
    replace_text: "#4CAF50",
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

// ---------------------------------------------------------------------------
// Diff engine — line-level LCS + word-level highlighting
// ---------------------------------------------------------------------------

// Line-level LCS → array of { text, type: "equal"|"removed"|"added" }
function _lineLCS(oldLines, newLines) {
  const n = oldLines.length, m = newLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);

  const result = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ text: oldLines[--i], type: "equal" }); j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ text: newLines[--j], type: "added" });
    } else {
      result.push({ text: oldLines[--i], type: "removed" });
    }
  }
  result.reverse();
  return result;
}

// Word-level diff between two strings → array of { text, hl: bool }
function _wordDiff(a, b) {
  // Split into tokens preserving whitespace
  const tokenize = (s) => s.match(/\S+|\s+/g) || [];
  const tokA = tokenize(a), tokB = tokenize(b);
  const n = tokA.length, m = tokB.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      dp[i][j] = tokA[i - 1] === tokB[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);

  // Build result for side a (removed tokens highlighted)
  const aResult = [], bResult = [];
  let i = n, j = m;
  const stackA = [], stackB = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && tokA[i - 1] === tokB[j - 1]) {
      stackA.push({ text: tokA[--i], hl: false }); stackB.push({ text: tokB[--j], hl: false });
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stackB.push({ text: tokB[--j], hl: true });
    } else {
      stackA.push({ text: tokA[--i], hl: true });
    }
  }
  stackA.reverse(); stackB.reverse();
  return { aTokens: stackA, bTokens: stackB };
}

// Build full diff model with line numbers + word-level highlights
function computeDiffModel(oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const raw = _lineLCS(oldLines, newLines);

  // Pair adjacent removed/added blocks for word-level diff
  const entries = [];
  let oldNum = 0, newNum = 0;
  let idx = 0;

  while (idx < raw.length) {
    if (raw[idx].type === "equal") {
      oldNum++; newNum++;
      entries.push({ type: "equal", text: raw[idx].text, oldNum, newNum });
      idx++;
    } else {
      // Collect contiguous removed + added block
      const removed = [], added = [];
      while (idx < raw.length && raw[idx].type === "removed") removed.push(raw[idx++]);
      while (idx < raw.length && raw[idx].type === "added") added.push(raw[idx++]);

      // Pair them for word-level diff
      const pairs = Math.min(removed.length, added.length);
      for (let p = 0; p < pairs; p++) {
        const wd = _wordDiff(removed[p].text, added[p].text);
        oldNum++;
        entries.push({ type: "removed", tokens: wd.aTokens, oldNum, newNum: null });
        newNum++;
        entries.push({ type: "added", tokens: wd.bTokens, oldNum: null, newNum });
      }
      // Remaining unpaired
      for (let p = pairs; p < removed.length; p++) {
        oldNum++;
        entries.push({ type: "removed", tokens: [{ text: removed[p].text, hl: true }], oldNum, newNum: null });
      }
      for (let p = pairs; p < added.length; p++) {
        newNum++;
        entries.push({ type: "added", tokens: [{ text: added[p].text, hl: true }], oldNum: null, newNum });
      }
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Confirmation overlay
// ---------------------------------------------------------------------------
function showConfirmOverlay(action, currentValue = null, totalActions = 1) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "aprova-confirm-overlay";

    const labels = {
      fill_text: "Preencher texto",
      replace_text: "Substituir texto",
      select_option: "Seleccionar opção",
      click_radio: "Seleccionar radio",
      click_checkbox: "Marcar checkbox",
      click_button: "Clicar botão",
      wait: "Esperar",
      scroll_to: "Scroll",
    };

    const target = findElement(action);
    const useDiff = (action.type === "fill_text" || action.type === "replace_text") && currentValue != null && currentValue.length > 0;

    if (useDiff) {
      // ── GitHub-style unified diff with word-level highlights ──
      overlay.innerHTML = `
        <div class="aprova-confirm-box aprova-confirm-box--diff">
          <div class="aprova-confirm-top-bar">
            <div class="aprova-confirm-type">${labels[action.type] || action.type}</div>
            <div class="aprova-confirm-desc">${action.description || action.selector || ""}</div>
          </div>
          <div class="aprova-diff-viewer">
            <table class="aprova-diff-table"><tbody></tbody></table>
          </div>
          <div class="aprova-confirm-buttons">
            <button class="aprova-btn aprova-btn-stop">Parar Todas</button>
            <button class="aprova-btn aprova-btn-skip">Não Aplicar e Continuar</button>
            <button class="aprova-btn aprova-btn-yes">Aplicar e Continuar</button>
          </div>
        </div>`;

      // For replace_text, compute the full result text with the replacement applied
      let newValue = action.value;
      if (action.type === "replace_text" && action.oldValue) {
        const rr = robustReplace(currentValue, action.oldValue, action.value);
        newValue = rr.success ? rr.result : currentValue;
      }
      const entries = computeDiffModel(currentValue, newValue);
      const tbody = overlay.querySelector(".aprova-diff-table tbody");

      for (const entry of entries) {
        const tr = document.createElement("tr");
        tr.className = `aprova-diff-row aprova-diff-row--${entry.type}`;

        // Old line number
        const tdOld = document.createElement("td");
        tdOld.className = "aprova-diff-num";
        tdOld.textContent = entry.oldNum ?? "";
        tr.appendChild(tdOld);

        // New line number
        const tdNew = document.createElement("td");
        tdNew.className = "aprova-diff-num";
        tdNew.textContent = entry.newNum ?? "";
        tr.appendChild(tdNew);

        // Marker column
        const tdMark = document.createElement("td");
        tdMark.className = "aprova-diff-mark";
        tdMark.textContent = entry.type === "removed" ? "\u2212" : entry.type === "added" ? "+" : "";
        tr.appendChild(tdMark);

        // Content column
        const tdContent = document.createElement("td");
        tdContent.className = "aprova-diff-text";

        if (entry.type === "equal") {
          tdContent.textContent = entry.text || "\u00A0";
        } else {
          // Word-level tokens with highlights
          for (const tok of entry.tokens) {
            const span = document.createElement("span");
            if (tok.hl) span.className = "aprova-diff-hl";
            span.textContent = tok.text;
            tdContent.appendChild(span);
          }
          if (!entry.tokens.length) tdContent.textContent = "\u00A0";
        }

        tr.appendChild(tdContent);
        tbody.appendChild(tr);
      }

    } else {
      // ── Simple view (non-diff) ──
      overlay.innerHTML = `
        <div class="aprova-confirm-box">
          <div class="aprova-confirm-type">${labels[action.type] || action.type}</div>
          <div class="aprova-confirm-desc">${action.description || action.selector || ""}</div>
          ${action.value ? '<textarea class="aprova-confirm-value" readonly></textarea>' : ""}
          <div class="aprova-confirm-buttons">
            <button class="aprova-btn aprova-btn-stop">Parar Todas</button>
            <button class="aprova-btn aprova-btn-skip">Não Aplicar e Continuar</button>
            <button class="aprova-btn aprova-btn-yes">Aplicar e Continuar</button>
          </div>
        </div>`;

      const valueEl = overlay.querySelector(".aprova-confirm-value");
      if (valueEl) {
        valueEl.value = action.value;
      }
    }

    function dismiss(result) {
      overlay.remove();
      if (target) target.style.outline = "";
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }

    overlay.querySelector(".aprova-btn-yes").onclick = () => dismiss(true);
    const skipBtn = overlay.querySelector(".aprova-btn-skip");
    if (totalActions <= 1) {
      skipBtn.disabled = true;
    } else {
      skipBtn.onclick = () => dismiss(false);
    }
    overlay.querySelector(".aprova-btn-stop").onclick = () => dismiss("stop");

    function onKey(e) {
      if (e.key === "Enter") { e.preventDefault(); dismiss(true); }
      else if (e.key === "Escape" && e.shiftKey) { e.preventDefault(); dismiss("stop"); }
      else if (e.key === "Escape" && totalActions > 1) { e.preventDefault(); dismiss(false); }
    }
    document.addEventListener("keydown", onKey);

    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.style.outline = "3px solid #FF9800";
    }

    document.body.appendChild(overlay);
  });
}

async function executeAction(action, confirmMode, totalActions = 1) {
  if (confirmMode) {
    let currentValue = null;
    if (action.type === "fill_text" || action.type === "replace_text") {
      const el = findElement(action);
      if (el) currentValue = el.value || "";
    }
    const approved = await showConfirmOverlay(action, currentValue, totalActions);
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
      // Strategy 1: Direct value + events (works for most inputs/textareas)
      el.focus();
      try {
        // Use native setter to bypass React/Angular controlled inputs
        const nativeSetter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(el), "value"
        )?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
          || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (nativeSetter) {
          nativeSetter.call(el, action.value);
        } else {
          el.value = action.value;
        }
      } catch (_) {
        el.value = action.value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      // Strategy 2: Verify — if value didn't stick, try setAttribute
      if (el.value !== action.value) {
        el.setAttribute("value", action.value);
        el.value = action.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      break;
    }
    case "replace_text": {
      el.focus();
      const rr = robustReplace(el.value, action.oldValue, action.value);
      if (!rr.success) {
        highlightElement(el, action.type);
        return { status: "skipped", action, reason: `Texto "${(action.oldValue || "").substring(0, 60)}" não encontrado no campo` };
      }
      try {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(el), "value"
        )?.set || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (nativeSetter) nativeSetter.call(el, rr.result);
        else el.value = rr.result;
      } catch (_) {
        el.value = rr.result;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      break;
    }
    case "select_option": {
      const val = action.value;
      // Strategy 1: Exact value match
      if ([...el.options].some((o) => o.value === val)) {
        el.value = val;
      }
      // Strategy 2: Case-insensitive value match
      else {
        const match = [...el.options].find((o) =>
          o.value.toLowerCase() === val.toLowerCase()
        );
        if (match) {
          el.value = match.value;
        }
        // Strategy 3: Match by option text (label)
        else {
          const textMatch = [...el.options].find((o) =>
            o.text.trim().toLowerCase() === val.toLowerCase()
          );
          if (textMatch) {
            el.value = textMatch.value;
          }
          // Strategy 4: Partial text match on label
          else {
            const partialMatch = [...el.options].find((o) =>
              o.text.trim().toLowerCase().includes(val.toLowerCase()) ||
              val.toLowerCase().includes(o.text.trim().toLowerCase())
            );
            if (partialMatch) {
              el.value = partialMatch.value;
            } else {
              // No match found — set value anyway (may not work but triggers change)
              el.value = val;
            }
          }
        }
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Some frameworks need a second pass
      if (el.value !== val && el.value !== el.options[el.selectedIndex]?.value) {
        el.selectedIndex = [...el.options].findIndex((o) =>
          o.value === el.value || o.text.trim().toLowerCase() === val.toLowerCase()
        );
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      break;
    }
    case "click_radio":
    case "click_checkbox": {
      const shouldCheck = action.value !== false && action.value !== "false" && action.value !== "0";
      // Strategy 1: Set checked + click + events
      if (el.checked !== shouldCheck) {
        el.checked = shouldCheck;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.click();
      }
      // Strategy 2: If still not set, try direct click (toggles checkbox)
      if (el.checked !== shouldCheck) {
        el.click();
      }
      // Strategy 3: Force via native setter
      if (el.checked !== shouldCheck) {
        try {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype, "checked"
          )?.set;
          if (nativeSetter) {
            nativeSetter.call(el, shouldCheck);
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        } catch (_) {}
      }
      break;
    }
    case "click_button": {
      // Strategy 1: Direct click
      el.click();
      // Strategy 2: If it's a link, also try triggering navigation
      if (el.tagName === "A" && el.href && !el.onclick) {
        // click() should handle it, but dispatch MouseEvent as backup
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }
      // Strategy 3: Dispatch pointer + mouse events for frameworks that listen to those
      if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") {
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }
      break;
    }
  }

  highlightElement(el, action.type);
  return { status: "done", action };
}

async function executeActions(actions, confirmMode) {
  const results = [];
  for (const action of actions) {
    const result = await executeAction(action, confirmMode, actions.length);
    results.push(result);
    if (result.status === "stopped") {
      // Clean up any remaining overlays
      document.querySelectorAll(".aprova-confirm-overlay").forEach((el) => el.remove());
      break;
    }
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
