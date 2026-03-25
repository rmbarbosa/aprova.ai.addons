/**
 * Aprova.ai Extension — RPA UI Module
 * Recording controls, template review panel, section selector, submit progress.
 * Loaded in popup.html — isolated from core UI logic.
 * Author: Rui Barbosa @rmblda 2026
 */

const RPAUI = (() => {
  let _templateData = null;
  let _recording = false;

  // Refs (populated after DOM ready)
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function sendToBg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => resolve(resp || {}));
    });
  }

  function addChatMsg(text, cls) {
    const chat = $("chat");
    if (!chat) return;
    const div = document.createElement("div");
    div.className = `msg ${cls}`;
    div.textContent = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

  // ---------------------------------------------------------------------------
  // Recording flow
  // ---------------------------------------------------------------------------
  async function startRecording() {
    $("headerMenu")?.classList.remove("open");
    try {
      const result = await sendToBg({ action: "rpa-record-start" });
      if (result.error) {
        addChatMsg(`RPA: Falha ao iniciar gravação — ${result.error}`, "error");
        return;
      }
      _recording = true;
      _showRecordingBanner(true);
      addChatMsg("RPA: Gravação iniciada. Navegue pelas secções e clique Gravar em cada uma.", "system");
    } catch (err) {
      addChatMsg(`RPA: ${err.message}`, "error");
    }
  }

  async function stopRecording() {
    try {
      const template = await sendToBg({ action: "rpa-record-stop" });
      _recording = false;
      _showRecordingBanner(false);

      if (!template || !template.sections || template.sections.length === 0) {
        addChatMsg("RPA: Nenhum POST capturado durante a gravação.", "system");
        return;
      }

      const getCount = (template.vocabularies || []).length;
      const getInfo = getCount > 0 ? `, ${getCount} respostas GET capturadas` : "";
      addChatMsg(`RPA: Gravação terminada — ${template.sections.length} secções capturadas${getInfo}.`, "system");
      _templateData = template;
      showTemplatePanel(template);
    } catch (err) {
      _recording = false;
      _showRecordingBanner(false);
      addChatMsg(`RPA: ${err.message}`, "error");
    }
  }

  function _showRecordingBanner(show) {
    const banner = $("rpaBanner");
    if (banner) banner.style.display = show ? "flex" : "none";
    const stopBtn = $("rpaStopBtn");
    if (stopBtn) {
      stopBtn.onclick = stopRecording;
    }
  }

  // Listen for events from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "rpa-recording-detached") {
      _recording = false;
      _showRecordingBanner(false);
      addChatMsg(`RPA: Debugger desconectado (${msg.reason}). Gravação parada.`, "error");
      return;
    }
    if (msg.action === "rpa-capture-event" && _recording) {
      addChatMsg(
        `RPA: Secção "${msg.capture.sectionName || msg.capture.index}" capturada (${msg.capture.fieldCount} campos)`,
        "system"
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Template review panel
  // ---------------------------------------------------------------------------
  function showTemplatePanel(template) {
    _templateData = template;
    const panel = $("rpaPanel");
    const backdrop = $("rpaBackdrop");
    if (!panel || !backdrop) return;

    // Build section list
    const listEl = $("rpaSectionList");
    if (listEl) {
      listEl.innerHTML = "";
      template.sections.forEach((sec, i) => {
        const row = document.createElement("label");
        row.className = "rpa-section-row";
        row.innerHTML = `
          <input type="checkbox" class="rpa-section-check" data-index="${i}" ${sec.enabled !== false ? "checked" : ""}>
          <span class="rpa-section-name">${sec.name}</span>
          <span class="rpa-section-meta">${_countBodyFields(sec.body)} campos · ${sec.method} ${new URL(sec.postUrl).pathname}</span>
        `;
        listEl.appendChild(row);
      });
    }

    // Build template JSON in textarea
    _refreshTemplateText();

    // Show panel
    backdrop.classList.add("open");
    panel.classList.add("open");
  }

  function _refreshTemplateText() {
    const textarea = $("rpaTemplateText");
    if (!textarea || !_templateData) return;
    // Apply enabled states from checkboxes
    const checks = document.querySelectorAll(".rpa-section-check");
    checks.forEach((chk) => {
      const idx = parseInt(chk.dataset.index);
      if (_templateData.sections[idx]) {
        _templateData.sections[idx].enabled = chk.checked;
      }
    });
    // Show only enabled sections in textarea
    const filtered = { ..._templateData, sections: _templateData.sections.filter((s) => s.enabled !== false) };
    textarea.value = JSON.stringify(filtered, null, 2);
  }

  function _countBodyFields(obj, depth = 0) {
    if (depth > 10 || obj === null || obj === undefined) return 0;
    if (typeof obj !== "object") return 1;
    if (Array.isArray(obj)) return obj.reduce((s, i) => s + _countBodyFields(i, depth + 1), 0);
    return Object.values(obj).reduce((s, v) => s + _countBodyFields(v, depth + 1), 0);
  }

  function closeTemplatePanel() {
    $("rpaPanel")?.classList.remove("open");
    $("rpaBackdrop")?.classList.remove("open");
  }

  // ---------------------------------------------------------------------------
  // Template actions (footer buttons)
  // ---------------------------------------------------------------------------
  function copyTemplate() {
    const textarea = $("rpaTemplateText");
    if (textarea) navigator.clipboard.writeText(textarea.value);
  }

  function downloadTemplate() {
    const textarea = $("rpaTemplateText");
    if (!textarea) return;
    const blob = new Blob([textarea.value], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `form-template-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function saveTemplateToBridge() {
    const textarea = $("rpaTemplateText");
    if (!textarea) return;
    try {
      const template = JSON.parse(textarea.value);
      const project = document.getElementById("projectSelect")?.value || "default";
      const resp = await sendToBg({
        action: "rpa-save-template",
        project,
        template,
      });
      if (resp.error) {
        addChatMsg(`RPA: Falha ao gravar — ${resp.error}`, "error");
      } else {
        addChatMsg("RPA: Template enviado para o Bridge.", "system");
        closeTemplatePanel();
      }
    } catch (err) {
      addChatMsg(`RPA: JSON inválido — ${err.message}`, "error");
    }
  }


  // ---------------------------------------------------------------------------
  // Submit flow
  // ---------------------------------------------------------------------------
  async function submitTemplate() {
    const textarea = $("rpaTemplateText");
    if (!textarea) return;
    let template;
    try {
      template = JSON.parse(textarea.value);
    } catch (err) {
      addChatMsg(`RPA: JSON inválido — ${err.message}`, "error");
      return;
    }

    const enabled = template.sections.filter((s) => s.enabled !== false);
    if (enabled.length === 0) {
      addChatMsg("RPA: Nenhuma secção seleccionada.", "system");
      return;
    }

    closeTemplatePanel();
    addChatMsg(`RPA: A submeter ${enabled.length} secções...`, "system");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      addChatMsg("RPA: Sem tab activa.", "error");
      return;
    }

    const results = [];
    for (let i = 0; i < enabled.length; i++) {
      const sec = enabled[i];
      addChatMsg(`RPA: [${i + 1}/${enabled.length}] A submeter "${sec.name}"...`, "system");

      try {
        const resp = await chrome.tabs.sendMessage(tab.id, {
          action: "rpa-replay-fetch",
          url: sec.postUrl,
          method: sec.method || "POST",
          headers: sec.headers || {},
          body: JSON.stringify(sec.filledBody || sec.body),
        });

        const status = resp.ok ? "done" : "failed";
        results.push({ section: sec.name, status, httpStatus: resp.status });
        addChatMsg(
          `RPA: "${sec.name}" — ${resp.ok ? `OK (${resp.status})` : `FALHOU (${resp.status})`}`,
          resp.ok ? "system" : "error"
        );
      } catch (err) {
        results.push({ section: sec.name, status: "failed", error: err.message });
        addChatMsg(`RPA: "${sec.name}" — ERRO: ${err.message}`, "error");
      }

      // Brief pause between submissions
      if (i < enabled.length - 1) await new Promise((r) => setTimeout(r, 500));
    }

    const ok = results.filter((r) => r.status === "done").length;
    addChatMsg(`RPA: Submissão completa — ${ok}/${enabled.length} secções com sucesso.`, "system");
  }


  // ---------------------------------------------------------------------------
  // AI Generate — scan page structure + stage as attachment
  // ---------------------------------------------------------------------------
  async function aiGenerate() {
    $("attachMenu")?.classList.remove("open");

    // Toggle off if already staged
    if (window.pendingAiGenerate) {
      window.pendingAiGenerate = false;
      window._updateAiGenerateThumb();
      return;
    }

    // Capture form structure (same as Scan Form) so Claude sees the page context
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      addChatMsg("RPA: Sem tab activa.", "error");
      return;
    }

    addChatMsg("A ler estrutura da página...", "system");
    try {
      const data = await chrome.tabs.sendMessage(tab.id, { action: "describe-form-structure" });
      if (!data || !data.text) {
        addChatMsg("RPA: Nenhum campo encontrado nesta página.", "error");
        return;
      }
      // Stage form description via popup.js exposed function
      window.stageFormDesc(data.text, data.fieldCount || 0, "AI Generate");
    } catch (err) {
      addChatMsg(`RPA: Falha ao ler página — ${err.message}`, "error");
      return;
    }

    // Stage AI Generate flag
    window.pendingAiGenerate = true;
    window._updateAiGenerateThumb();
  }

  // ---------------------------------------------------------------------------
  // Init — wire up buttons after DOM ready
  // ---------------------------------------------------------------------------
  function init() {
    // Menu buttons
    $("rpaRecordBtn")?.addEventListener("click", startRecording);
    $("aiGenerateBtn")?.addEventListener("click", aiGenerate);

    // Template panel buttons
    $("rpaPanelClose")?.addEventListener("click", closeTemplatePanel);
    $("rpaBackdrop")?.addEventListener("click", closeTemplatePanel);
    $("rpaCopyBtn")?.addEventListener("click", copyTemplate);
    $("rpaDownloadBtn")?.addEventListener("click", downloadTemplate);
    $("rpaSaveBridgeBtn")?.addEventListener("click", saveTemplateToBridge);
    $("rpaCancelBtn")?.addEventListener("click", closeTemplatePanel);
    $("rpaSubmitBtn")?.addEventListener("click", submitTemplate);

    // Tab switching in template panel
    document.querySelectorAll(".rpa-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".rpa-tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".rpa-tab-content").forEach((c) => c.classList.remove("active"));
        tab.classList.add("active");
        document.querySelector(`[data-rpa-tab-content="${tab.dataset.rpaTab}"]`)?.classList.add("active");
        if (tab.dataset.rpaTab === "template") _refreshTemplateText();
      });
    });

    // Section checkboxes → refresh template text
    $("rpaSectionList")?.addEventListener("change", () => _refreshTemplateText());
  }

  // Auto-init when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { startRecording, stopRecording, showTemplatePanel, aiGenerate };
})();
