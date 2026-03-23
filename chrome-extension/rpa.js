/**
 * Aprova.ai Extension — RPA Module
 * Records form POST requests via CDP, compiles templates, replays submissions.
 * Isolated module — can be removed without affecting core extension.
 * Author: Rui Barbosa @rmblda 2026
 */

// ---------------------------------------------------------------------------
// Debugger lifecycle (shared with captureFullPage in background.js)
// ---------------------------------------------------------------------------
const RPA = (() => {
  let _recording = false;
  let _recordingTabId = null;
  let _captures = [];
  let _startTime = null;
  let _requestMap = {}; // requestId → capture data
  let _fetchEnabled = false;

  // ---------------------------------------------------------------------------
  // CDP helpers (reuse debuggerSend from background.js scope)
  // ---------------------------------------------------------------------------

  function _cdpSend(tabId, method, params = {}) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      });
    });
  }

  function _attachDebugger(tabId) {
    return new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  function _detachDebugger(tabId) {
    return new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => resolve());
    });
  }

  // ---------------------------------------------------------------------------
  // CDP event handler
  // ---------------------------------------------------------------------------
  function _onDebuggerEvent(source, method, params) {
    if (!_recording || source.tabId !== _recordingTabId) return;

    if (method === "Fetch.requestPaused") {
      _handleFetchPaused(source.tabId, params);
    }

    // Fallback: capture POSTs via Network domain when Fetch is not available
    if (method === "Network.requestWillBeSent" && !_fetchEnabled) {
      const req = params.request;
      if (req.method === "POST" || req.method === "PUT") {
        _handleNetworkPost(source.tabId, params);
      }
    }

    if (method === "Network.responseReceived") {
      const cap = _requestMap[params.requestId];
      if (cap) {
        cap.responseStatus = params.response?.status || null;
      }
    }
  }

  function _onDebuggerDetach(source, reason) {
    if (source.tabId === _recordingTabId && _recording) {
      _recording = false;
      chrome.runtime.sendMessage({
        action: "rpa-recording-detached",
        reason: reason || "unknown",
      }).catch(() => {});
    }
  }

  // Fallback: capture POST from Network.requestWillBeSent
  async function _handleNetworkPost(tabId, params) {
    const req = params.request;
    // Try to get full body via Network.getRequestPostData
    let postData = req.postData || "";
    if (params.requestId) {
      try {
        const full = await _cdpSend(tabId, "Network.getRequestPostData", {
          requestId: params.requestId,
        });
        if (full?.postData) postData = full.postData;
      } catch (_) {}
    }

    let bodyParsed = null;
    if (postData) {
      try { bodyParsed = JSON.parse(postData); } catch (_) {}
    }

    const capture = {
      requestId: params.requestId,
      networkId: params.requestId,
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: postData,
      bodyParsed,
      timestamp: Date.now(),
      responseStatus: null,
      sectionName: null,
      domSnapshot: null,
    };

    _captures.push(capture);
    _requestMap[params.requestId] = capture;

    // Section context
    chrome.tabs.sendMessage(_recordingTabId, { action: "rpa-capture-section-context" }, (ctx) => {
      if (ctx && !chrome.runtime.lastError) {
        capture.sectionName = ctx.sectionName || `Secção ${_captures.length}`;
        capture.domSnapshot = ctx;
      }
    });

    // Notify popup
    chrome.runtime.sendMessage({
      action: "rpa-capture-event",
      capture: {
        url: req.url,
        method: req.method,
        fieldCount: bodyParsed ? _countFields(bodyParsed) : 0,
        index: _captures.length,
        sectionName: capture.sectionName,
      },
    }).catch(() => {});
  }

  async function _handleFetchPaused(tabId, params) {
    const req = params.request;
    const isPost = req.method === "POST" || req.method === "PUT";

    if (isPost) {
      // Get request body — try params.request.postData first, then Fetch.getRequestPostData
      let postData = req.postData || null;

      if (!postData && params.requestId) {
        try {
          const bodyResult = await _cdpSend(tabId, "Fetch.getRequestPostData", {
            requestId: params.requestId,
          });
          postData = bodyResult?.postData || null;
        } catch (_) {}
      }

      let bodyParsed = null;
      if (postData) {
        try { bodyParsed = JSON.parse(postData); } catch (_) {}
      }

      const capture = {
        requestId: params.requestId,
        networkId: params.networkId,
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: postData || "",
        bodyParsed,
        timestamp: Date.now(),
        responseStatus: null,
        sectionName: null,
        domSnapshot: null,
      };

      _captures.push(capture);
      _requestMap[params.networkId || params.requestId] = capture;

      // Ask content script for section context (async, non-blocking)
      chrome.tabs.sendMessage(_recordingTabId, { action: "rpa-capture-section-context" }, (ctx) => {
        if (ctx && !chrome.runtime.lastError) {
          capture.sectionName = ctx.sectionName || `Secção ${_captures.length}`;
          capture.domSnapshot = ctx;
        }
      });

      // Notify popup about new capture
      chrome.runtime.sendMessage({
        action: "rpa-capture-event",
        capture: {
          url: req.url,
          method: req.method,
          fieldCount: bodyParsed ? _countFields(bodyParsed) : 0,
          index: _captures.length,
          sectionName: capture.sectionName,
        },
      }).catch(() => {});
    }

    // Always continue the request (never block)
    try {
      await _cdpSend(tabId, "Fetch.continueRequest", {
        requestId: params.requestId,
      });
    } catch (_) {
      // If continueRequest fails, try fulfilling to unblock
      try {
        await _cdpSend(tabId, "Fetch.failRequest", {
          requestId: params.requestId,
          errorReason: "Failed",
        });
      } catch (_) {}
    }
  }

  // ---------------------------------------------------------------------------
  // Field counting helper
  // ---------------------------------------------------------------------------
  function _countFields(obj, depth = 0) {
    if (depth > 10) return 0;
    if (obj === null || obj === undefined) return 0;
    if (typeof obj !== "object") return 1;
    if (Array.isArray(obj)) {
      return obj.reduce((sum, item) => sum + _countFields(item, depth + 1), 0);
    }
    return Object.values(obj).reduce((sum, val) => sum + _countFields(val, depth + 1), 0);
  }

  // ---------------------------------------------------------------------------
  // Recording API
  // ---------------------------------------------------------------------------
  async function startRecording() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab");

    _recordingTabId = tab.id;
    _captures = [];
    _requestMap = {};
    _startTime = Date.now();

    // Attach debugger
    await _attachDebugger(tab.id);

    // Register event listener BEFORE enabling domains
    chrome.debugger.onEvent.removeListener(_onDebuggerEvent);
    chrome.debugger.onEvent.addListener(_onDebuggerEvent);

    // Handle debugger detach (user clicks dismiss or navigation)
    chrome.debugger.onDetach.removeListener(_onDebuggerDetach);
    chrome.debugger.onDetach.addListener(_onDebuggerDetach);

    // Enable Network (for response status + fallback body capture)
    await _cdpSend(tab.id, "Network.enable");

    // Try Fetch domain (gives full request body access, but pauses requests)
    _fetchEnabled = false;
    try {
      await _cdpSend(tab.id, "Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      });
      _fetchEnabled = true;
    } catch (e) {
      // Fetch domain not available — fall back to Network-only mode
      console.warn("RPA: Fetch.enable failed, using Network-only mode:", e.message);
    }

    _recording = true;
    return { tabId: tab.id, url: tab.url, fetchEnabled: _fetchEnabled };
  }

  async function stopRecording() {
    if (!_recording || !_recordingTabId) return { captures: [] };

    _recording = false;

    try {
      if (_fetchEnabled) await _cdpSend(_recordingTabId, "Fetch.disable");
      await _cdpSend(_recordingTabId, "Network.disable");
    } catch (_) {}

    try {
      await _detachDebugger(_recordingTabId);
    } catch (_) {}

    chrome.debugger.onEvent.removeListener(_onDebuggerEvent);
    chrome.debugger.onDetach.removeListener(_onDebuggerDetach);

    const template = _compileTemplate();
    _recordingTabId = null;
    _requestMap = {};

    return template;
  }

  function isRecording() {
    return _recording;
  }

  function getCaptures() {
    return _captures.map((c, i) => ({
      index: i,
      url: c.url,
      method: c.method,
      sectionName: c.sectionName || `Secção ${i + 1}`,
      fieldCount: c.bodyParsed ? _countFields(c.bodyParsed) : 0,
      responseStatus: c.responseStatus,
      timestamp: c.timestamp,
    }));
  }

  // ---------------------------------------------------------------------------
  // Template compilation
  // ---------------------------------------------------------------------------
  function _compileTemplate() {
    const sections = _captures
      .filter((c) => c.bodyParsed) // only JSON POST bodies
      .map((c, i) => {
        // Detect dynamic headers
        const dynamicHeaders = [];
        const staticHeaders = {};
        for (const [key, val] of Object.entries(c.headers || {})) {
          const lk = key.toLowerCase();
          if (lk === "cookie" || lk.includes("csrf") || lk.includes("token") || lk.includes("verification")) {
            dynamicHeaders.push(key);
          } else {
            staticHeaders[key] = val;
          }
        }

        return {
          order: i + 1,
          enabled: true,
          name: c.sectionName || `Secção ${i + 1}`,
          postUrl: c.url,
          method: c.method,
          headers: staticHeaders,
          dynamicHeaders,
          body: c.bodyParsed,
          responseStatus: c.responseStatus,
          domContext: c.domSnapshot
            ? {
                sectionName: c.domSnapshot.sectionName,
                pageTitle: c.domSnapshot.pageTitle,
                fields: c.domSnapshot.fields || [],
              }
            : null,
        };
      });

    return {
      templateVersion: "1.0",
      formName: "",
      formUrl: _captures[0]?.url?.split("?")[0] || "",
      recordedAt: new Date(_startTime).toISOString(),
      sections,
    };
  }

  // ---------------------------------------------------------------------------
  // Replay engine
  // ---------------------------------------------------------------------------
  async function replaySection(section, tabId) {
    // Get fresh CSRF token from content script
    let csrfData = {};
    try {
      csrfData = await chrome.tabs.sendMessage(tabId, { action: "rpa-get-csrf" }) || {};
    } catch (_) {}

    // Build headers
    const headers = { ...section.headers };
    // Inject fresh CSRF if found
    if (csrfData.headerName && csrfData.headerValue) {
      headers[csrfData.headerName] = csrfData.headerValue;
    }

    // Build body — inject CSRF token into body if needed
    let body = section.filledBody || section.body;
    if (typeof body === "object") {
      if (csrfData.bodyField && csrfData.bodyValue) {
        body = { ...body, [csrfData.bodyField]: csrfData.bodyValue };
      }
      body = JSON.stringify(body);
    }

    // Execute fetch from content script (same origin → cookies auto-included)
    const result = await chrome.tabs.sendMessage(tabId, {
      action: "rpa-replay-fetch",
      url: section.postUrl,
      method: section.method || "POST",
      headers,
      body,
    });

    return result;
  }

  async function replayAll(template, tabId, onProgress) {
    const results = [];
    const enabled = template.sections.filter((s) => s.enabled !== false);

    for (let i = 0; i < enabled.length; i++) {
      const section = enabled[i];
      if (onProgress) onProgress({ phase: "submitting", index: i, total: enabled.length, section: section.name });

      try {
        const result = await replaySection(section, tabId);
        results.push({ section: section.name, order: section.order, ...result });
      } catch (err) {
        results.push({ section: section.name, order: section.order, status: 0, error: err.message });
      }

      // Brief pause between submissions
      if (i < enabled.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  return {
    startRecording,
    stopRecording,
    isRecording,
    getCaptures,
    replaySection,
    replayAll,
  };
})();
