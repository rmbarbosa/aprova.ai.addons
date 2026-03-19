/**
 * Aprova.ai Extension — Content Script
 * Scans form fields, executes fill actions, shows overlays.
 * Author: Rui Barbosa @rmblda 2026
 */

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
    const valuePreview = action.value
      ? `<div class="aprova-confirm-value">${action.value}</div>`
      : "";

    overlay.innerHTML = `
      <div class="aprova-confirm-box">
        <div class="aprova-confirm-type">${labels[action.type] || action.type}</div>
        <div class="aprova-confirm-desc">${action.description || action.selector || ""}</div>
        ${valuePreview}
        <div class="aprova-confirm-buttons">
          <button class="aprova-btn aprova-btn-yes">OK</button>
          <button class="aprova-btn aprova-btn-skip">Skip</button>
          <button class="aprova-btn aprova-btn-stop">Stop</button>
        </div>
      </div>`;

    overlay.querySelector(".aprova-btn-yes").onclick = () => {
      overlay.remove();
      if (target) target.style.outline = "";
      resolve(true);
    };
    overlay.querySelector(".aprova-btn-skip").onclick = () => {
      overlay.remove();
      if (target) target.style.outline = "";
      resolve(false);
    };
    overlay.querySelector(".aprova-btn-stop").onclick = () => {
      overlay.remove();
      if (target) target.style.outline = "";
      resolve("stop");
    };

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
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

      default:
        sendResponse({ error: `Unknown content action: ${msg.action}` });
    }
  })();
  return true;
});

// ---------------------------------------------------------------------------
// Page load indicator
// ---------------------------------------------------------------------------

(function init() {
  // Small badge to show extension is active
  const badge = document.createElement("div");
  badge.className = "aprova-badge";
  badge.textContent = "A";
  badge.title = "Aprova.ai Extension active";
  document.body.appendChild(badge);
})();
