#!/usr/bin/env python3
"""
Aprova.ai Bridge Server — Flask + Claude Agent SDK
Connects Chrome Extension to Claude Code with persistent sessions.

Usage:
    py -3 aprova_ai_bridge.py              # normal mode (with system tray icon)
    py -3 aprova_ai_bridge.py --headless   # no tray icon, terminal mode
    py -3 aprova_ai_bridge.py -d           # daemon mode (detached background process)
    py -3 aprova_ai_bridge.py -f           # force restart (kills existing instance)
    py -3 aprova_ai_bridge.py -d -f        # daemon + force restart
    py -3 aprova_ai_bridge.py --headless -v # headless + verbose request logging

Author: Rui Barbosa @rmblda 2026
"""

import asyncio
import json
import os
import sys
import threading
import time
from pathlib import Path

from flask import Flask, request, jsonify, Response
from flask_cors import CORS

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PROJECT_DIR = Path(os.environ.get("APROVA_PROJECT_DIR", r"C:\trabalhos\aprova.ai"))
HOST = "127.0.0.1"
PORT = 9090

app = Flask(__name__)
app.json.ensure_ascii = False
# CORS: allow Chrome extension origin (update ID after install)
CORS(app, resources={r"/*": {"origins": ["chrome-extension://*", "http://localhost:*"]}})

# Active sessions: project_slug -> { session_id, mode, created }
sessions = {}
VERBOSE = False

# Browser state pushed by the Chrome extension
_browser_state = {"pageScan": None, "tabUrl": None, "tabTitle": None, "timestamp": None}
BROWSER_STATE_FILE = PROJECT_DIR / "tmp" / ".browser-state.json"

# ---------------------------------------------------------------------------
# Helpers — Claude Agent SDK
# ---------------------------------------------------------------------------

def _run_async(coro):
    """Run an async coroutine from sync Flask context."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _patch_sdk_parser():
    """Patch the SDK message parser to skip unknown types instead of raising."""
    from claude_code_sdk._internal import message_parser, client
    from claude_code_sdk._errors import MessageParseError
    _original = message_parser.parse_message

    class _SkippedMessage:
        """Placeholder for unknown message types."""
        def __init__(self, data):
            self.data = data

    def _patched(data):
        try:
            return _original(data)
        except MessageParseError:
            return _SkippedMessage(data)

    # Patch both the module attribute and the already-imported reference in client
    message_parser.parse_message = _patched
    client.parse_message = _patched
    return _SkippedMessage

_SkippedMessage = _patch_sdk_parser()


def _permissions_to_tools(permissions):
    """Map extension permission mode to allowed_tools list."""
    if permissions == "readonly":
        return ["Read", "Glob", "Grep"]
    return ["Read", "Write", "Edit", "Glob", "Grep"]  # readwrite (default)


async def _sdk_query(prompt, session_id=None, allowed_tools=None):
    """Send a prompt to Claude Agent SDK and return the result text + session_id."""
    from claude_code_sdk import query as sdk_query, ClaudeCodeOptions

    options = ClaudeCodeOptions(
        allowed_tools=allowed_tools or ["Read", "Write", "Edit", "Glob", "Grep"],
        cwd=str(PROJECT_DIR),
    )
    if session_id:
        options.resume = session_id

    result_text = ""
    new_session_id = session_id
    had_tool_use = False
    rate_limited = False
    steps = []  # intermediate thinking/tool steps for UI

    async for msg in sdk_query(prompt=prompt, options=options):
        # Handle skipped/unknown message types (e.g. rate_limit_event)
        if isinstance(msg, _SkippedMessage):
            data = getattr(msg, "data", {}) or {}
            if data.get("type") == "rate_limit_event":
                info = data.get("rate_limit_info", {})
                if VERBOSE:
                    log(f"  sdk msg  {_DM}rate_limit ({info.get('status', '?')}){_R}", "warn")
                if info.get("status") != "allowed":
                    rate_limited = True
            continue

        cls = type(msg).__name__
        if VERBOSE:
            log(f"  sdk msg  {_DM}{cls}{_R}")

        # SystemMessage — extract session_id from init
        if cls == "SystemMessage":
            data = getattr(msg, "data", {}) or {}
            sid = data.get("session_id")
            if sid:
                new_session_id = sid

        # AssistantMessage — extract text and tool use from content blocks
        elif cls == "AssistantMessage":
            content = getattr(msg, "content", None)
            if content and isinstance(content, list):
                for block in content:
                    btype = type(block).__name__
                    if btype == "ThinkingBlock":
                        thinking = getattr(block, "text", "")
                        if thinking:
                            steps.append({"type": "thinking", "text": thinking[:200]})
                    elif btype == "ToolUseBlock":
                        had_tool_use = True
                        tool_name = getattr(block, "name", "?")
                        tool_input = getattr(block, "input", {}) or {}
                        # Build a human-readable description
                        desc = tool_name
                        if tool_name in ("Read", "Glob", "Grep"):
                            target = (tool_input.get("file_path")
                                      or tool_input.get("pattern")
                                      or tool_input.get("path", ""))
                            if target:
                                # Shorten paths
                                target = str(target).replace(str(PROJECT_DIR), ".")
                                desc = f"{tool_name} {target}"
                        steps.append({"type": "tool", "text": desc})
                    elif hasattr(block, "text"):
                        result_text = block.text

        # ResultMessage — final result
        elif cls == "ResultMessage":
            result_text = getattr(msg, "result", "") or result_text
            sid = getattr(msg, "session_id", None)
            if sid:
                new_session_id = sid

    # If we got tool use but no text, the session was likely rate-limited mid-conversation
    if not result_text and rate_limited:
        result_text = ("Rate limit atingido — a sessão Claude foi interrompida a meio. "
                       "Aguarda alguns minutos e tenta novamente.")
    elif not result_text and had_tool_use:
        result_text = ("A sessão foi interrompida antes de completar a resposta. "
                       "Tenta novamente.")

    return result_text, new_session_id, steps


# ---------------------------------------------------------------------------
# Verbose request logging
# ---------------------------------------------------------------------------

@app.before_request
def _log_request():
    if not VERBOSE:
        return
    body = request.get_json(silent=True)
    body_str = ""
    if body:
        body_str = f"  {_DM}{json.dumps(body, ensure_ascii=False)[:200]}{_R}"
    log(f"{_C}{request.method}{_R} {_W}{request.path}{_R}{body_str}")


@app.after_request
def _log_response(response):
    if not VERBOSE:
        return response
    try:
        data = response.get_json(silent=True)
        preview = json.dumps(data, ensure_ascii=False)[:200] if data else ""
    except Exception:
        preview = ""
    status_code = response.status_code
    lvl = "ok" if status_code < 400 else "err"
    log(f"  {_DM}{status_code}{_R} {preview}", lvl)
    return response


# ---------------------------------------------------------------------------
# Routes — Health / Status
# ---------------------------------------------------------------------------

@app.route("/status", methods=["GET"])
def status():
    """Health check + active sessions."""
    return jsonify({
        "status": "ok",
        "sessions": {k: {"session_id": v["session_id"], "mode": v["mode"]}
                     for k, v in sessions.items()},
        "project_dir": str(PROJECT_DIR),
    })


@app.route("/projects", methods=["GET"])
def list_projects():
    """List available project folders inside PROJECT_DIR/projects/."""
    projects_path = PROJECT_DIR / "projects"
    names = []
    if projects_path.is_dir():
        for entry in sorted(projects_path.iterdir()):
            if entry.is_dir() and not entry.name.startswith("."):
                names.append(entry.name)
    return jsonify({"projects": names})


# ---------------------------------------------------------------------------
# Routes — Browser State (pushed by Chrome extension)
# ---------------------------------------------------------------------------

def _write_browser_state():
    """Write current browser state to JSON file for Claude Code to read."""
    from datetime import datetime, timezone
    ts = _browser_state.get("timestamp")
    age = (time.time() - ts) if ts else None
    data = {
        "tabUrl": _browser_state.get("tabUrl"),
        "tabTitle": _browser_state.get("tabTitle"),
        "timestamp": ts,
        "iso_timestamp": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else None,
        "age_seconds": round(age, 1) if age is not None else None,
        "pageScan": _browser_state.get("pageScan"),
    }
    BROWSER_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    BROWSER_STATE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


@app.route("/browser/state", methods=["POST"])
def post_browser_state():
    """Receive page state push from Chrome extension."""
    data = request.json or {}
    _browser_state["pageScan"] = data.get("pageScan")
    _browser_state["tabUrl"] = data.get("tabUrl")
    _browser_state["tabTitle"] = data.get("tabTitle")
    _browser_state["timestamp"] = data.get("timestamp") or time.time()
    _write_browser_state()
    if VERBOSE:
        log(f"browser state updated  {_DM}{_browser_state['tabUrl']}{_R}")
    return jsonify({"status": "ok"})


@app.route("/browser/state", methods=["GET"])
def get_browser_state():
    """Return current browser state with age info."""
    ts = _browser_state.get("timestamp")
    age = (time.time() - ts) if ts else None
    return jsonify({
        **_browser_state,
        "age_seconds": round(age, 1) if age is not None else None,
        "stale": age > 60 if age is not None else True,
    })


# ---------------------------------------------------------------------------
# Routes — Session Management
# ---------------------------------------------------------------------------

@app.route("/session/list", methods=["GET"])
def list_sessions():
    """List live Claude Code sessions whose cwd targets the aprova.ai folder."""
    sessions_dir = Path.home() / ".claude" / "sessions"
    target_cwd = str(PROJECT_DIR).lower().rstrip("\\")
    live = []

    if sessions_dir.exists():
        for f in sessions_dir.iterdir():
            if f.suffix != ".json":
                continue
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                cwd = (data.get("cwd") or "").lower().rstrip("\\")
                if cwd != target_cwd:
                    continue
                pid = data.get("pid")
                session_id = data.get("sessionId", "")
                started = data.get("startedAt", 0)

                # Verify the process is still alive
                if pid and not _pid_alive(pid):
                    continue

                # Get last user message from the session JSONL
                last_user_msg = _get_last_user_msg(session_id)

                live.append({
                    "sessionId": session_id,
                    "pid": pid,
                    "cwd": data.get("cwd", ""),
                    "startedAt": started,
                    "lastMessage": last_user_msg,
                })
            except Exception:
                pass

    # Sort by start time, newest first
    live.sort(key=lambda x: x.get("startedAt", 0), reverse=True)
    return jsonify({"sessions": live})


def _pid_alive(pid):
    """Check if a process with the given PID is running (Windows-compatible)."""
    if sys.platform == "win32":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if handle:
            kernel32.CloseHandle(handle)
            return True
        return False
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def _get_last_user_msg(session_id):
    """Read the last user message from a session JSONL file."""
    projects_dir = Path.home() / ".claude" / "projects"
    # Search all project dirs for the session file
    for project_dir in projects_dir.iterdir():
        jsonl = project_dir / f"{session_id}.jsonl"
        if jsonl.exists():
            try:
                lines = jsonl.read_text(encoding="utf-8").strip().splitlines()
                for line in reversed(lines):
                    entry = json.loads(line)
                    if entry.get("type") == "user":
                        msg = entry.get("message", {})
                        content = msg.get("content", "")
                        if isinstance(content, str):
                            return content[:100]
                        if isinstance(content, list):
                            for block in content:
                                if isinstance(block, dict) and block.get("type") == "text":
                                    return block.get("text", "")[:100]
                        return ""
            except Exception:
                pass
    return ""


_INIT_PROMPT = """És o Boris, assistente do Aprova.ai para preenchimento de formulários de candidatura.

Projecto activo: projects/{project}/

Instruções:
1. Lê o _projeto.md, o guia de preenchimento (se existir), e os dados da empresa.
2. Fica pronto para responder perguntas sobre o projecto e ajudar a preencher formulários.
3. Quando te enviar campos do formulário, devolve JSON puro com acções de preenchimento.
4. Para perguntas normais, responde em markdown de forma concisa.
5. Nunca repitas informação já dada na conversa.

Confirma que estás pronto com um resumo curto do projecto."""


@app.route("/session/start", methods=["POST"])
def start_session():
    """Create a new Claude SDK session for a project."""
    data = request.json or {}
    project = data.get("project", "default")
    extra_prompt = data.get("initialPrompt", "")

    try:
        prompt = _INIT_PROMPT.format(project=project)
        if extra_prompt:
            prompt += "\n\n" + extra_prompt
        result, sid, steps = _run_async(_sdk_query(prompt))
        sessions[project] = {
            "session_id": sid,
            "mode": "created",
            "created": time.time(),
        }
        return jsonify({"sessionId": sid, "status": "ready", "message": result, "steps": steps})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/session/attach", methods=["POST"])
def attach_session():
    """Create a new extension session with the same project context as an existing one.
    We don't resume the live session (that would conflict with the running process).
    Instead, we create a fresh session seeded with the same project data."""
    data = request.json or {}
    session_id = data.get("sessionId")
    project = data.get("project", "default")
    extra_prompt = data.get("initialPrompt", "")

    if not session_id:
        return jsonify({"error": "sessionId required"}), 400

    try:
        prompt = _INIT_PROMPT.format(project=project)
        if extra_prompt:
            prompt += "\n\n" + extra_prompt
        result, sid, steps = _run_async(_sdk_query(prompt))
        sessions[project] = {
            "session_id": sid,
            "mode": "created",
            "created": time.time(),
        }
        return jsonify({"sessionId": sid, "status": "ready", "message": result, "steps": steps})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/session/end", methods=["POST"])
def end_session():
    """End or detach session for a project."""
    data = request.json or {}
    project = data.get("project", "default")

    if project in sessions:
        mode = sessions[project]["mode"]
        del sessions[project]
        return jsonify({"status": "ended" if mode == "created" else "detached"})

    return jsonify({"error": "no active session for project"}), 404


# ---------------------------------------------------------------------------
# Routes — Fill / Fix / Ask / Validate
# ---------------------------------------------------------------------------

def _get_session(project):
    """Get session_id for a project or return error tuple."""
    entry = sessions.get(project)
    if not entry:
        return None
    return entry["session_id"]


@app.route("/fill", methods=["POST"])
def fill():
    """Send page scan to Claude, get back fill actions."""
    data = request.json or {}
    project = data.get("project", "default")
    session_id = _get_session(project)
    permissions = data.get("permissions", "readwrite")
    tools = _permissions_to_tools(permissions)

    if not session_id:
        return jsonify({"error": "no active session — start or attach first"}), 400

    page_scan = data.get("pageScan", {})

    prompt = f"""Automatiza o preenchimento desta página do formulário.

Estado actual da página:
{json.dumps(page_scan, ensure_ascii=False, indent=2)}

Devolve uma lista sequencial de ACÇÕES em JSON puro (sem markdown fences):
- fill_text: preencher texto (selector, value, description)
- select_option: seleccionar combobox (selector, value, description)
- click_radio / click_checkbox: seleccionar (selector, value, description)
- click_button: clicar botão (selector, description)
- wait: esperar N ms (ms)

Formato: {{"actions": [...], "alerts": [...]}}
alerts = avisos sobre campos que não conseguiste preencher ou que precisam de confirmação."""

    try:
        result, _, steps = _run_async(_sdk_query(prompt, session_id=session_id, allowed_tools=tools))
        # Try to parse JSON from result
        parsed = _extract_json(result)
        parsed["steps"] = steps
        return jsonify(parsed)
    except Exception as e:
        return jsonify({"error": str(e), "raw": result if "result" in dir() else ""}), 500


@app.route("/fix", methods=["POST"])
def fix():
    """Fix a specific field value."""
    data = request.json or {}
    project = data.get("project", "default")
    session_id = _get_session(project)

    if not session_id:
        return jsonify({"error": "no active session"}), 400

    prompt = f"""Corrige o campo "{data.get('fieldLabel', '')}".
Valor actual: {data.get('currentValue', '')}
Problema: {data.get('feedback', '')}
Devolve JSON puro: {{"actions": [{{"type": "fill_text", "selector": "...", "value": "novo valor", "description": "..."}}]}}"""

    try:
        result, _, steps = _run_async(_sdk_query(prompt, session_id=session_id))
        parsed = _extract_json(result)
        parsed["steps"] = steps
        return jsonify(parsed)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/ask", methods=["POST"])
def ask():
    """Free-form question to Claude ('Ask Boris').
    If pageScan is included, Claude gets page context and may return actions."""
    data = request.json or {}
    project = data.get("project", "default")
    session_id = _get_session(project)

    if not session_id:
        return jsonify({"error": "no active session"}), 400

    question = data.get("question", "")
    if not question:
        return jsonify({"error": "question required"}), 400

    page_scan = data.get("pageScan")
    screenshot = data.get("screenshot")
    permissions = data.get("permissions", "readwrite")
    tools = _permissions_to_tools(permissions)

    # If screenshot provided, save as temp file for Claude to read
    screenshot_path = None
    if screenshot:
        import base64, tempfile
        # Strip data URL prefix: "data:image/png;base64,..."
        header, b64data = screenshot.split(",", 1) if "," in screenshot else ("", screenshot)
        img_bytes = base64.b64decode(b64data)
        tmp = tempfile.NamedTemporaryFile(suffix=".png", prefix="aprova_screenshot_", delete=False,
                                          dir=str(PROJECT_DIR))
        tmp.write(img_bytes)
        tmp.close()
        screenshot_path = tmp.name

    if screenshot_path:
        ss_path = screenshot_path.replace("\\", "/")
        scan_section = ""
        if page_scan:
            scan_section = (
                f"\n\nDados estruturados da página (scan DOM):\n"
                f"{json.dumps(page_scan, ensure_ascii=False, indent=2)}\n"
            )
        prompt = (
            f"{question}\n\n"
            f"PRIMEIRO: lê o screenshot da página com Read file_path=\"{ss_path}\"\n"
            f"É uma imagem PNG do ecrã do utilizador. Analisa o que vês."
            f"{scan_section}\n"
            "[Instrução: responde de forma concisa e directa. "
            "Não repitas informação já dada nesta sessão. "
            "Usa markdown para formatar.]"
        )
    elif page_scan:
        prompt = f"""{question}

Estado actual da página:
{json.dumps(page_scan, ensure_ascii=False, indent=2)}

[Instrução: responde de forma concisa e directa.
Não repitas informação já dada nesta sessão.
Se o pedido envolve preencher/alterar campos, devolve JSON puro:
{{"actions": [...], "alerts": [...], "answer": "..."}}
Cada acção: {{"type": "fill_text|select_option|click_radio|click_checkbox|click_button", "selector": "...", "value": "...", "description": "..."}}
Se o pedido é só uma pergunta, responde normalmente em markdown.]"""
    else:
        prompt = (
            f"{question}\n\n"
            "[Instrução: responde de forma concisa e directa. "
            "Não repitas informação já dada nesta sessão. "
            "Usa markdown para formatar.]"
        )

    try:
        result, _, steps = _run_async(_sdk_query(prompt, session_id=session_id, allowed_tools=tools))

        # If page context was included, try to parse structured response
        if page_scan:
            parsed = _extract_json(result)
            if "actions" in parsed:
                return jsonify({
                    "actions": parsed["actions"],
                    "alerts": parsed.get("alerts", []),
                    "answer": parsed.get("answer", ""),
                    "steps": steps,
                })

        return jsonify({"answer": result, "steps": steps})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        # Clean up temp screenshot
        if screenshot_path:
            try:
                os.unlink(screenshot_path)
            except OSError:
                pass


@app.route("/ask/stream", methods=["POST"])
def ask_stream():
    """SSE streaming version of /ask — sends text chunks as they arrive."""
    data = request.json or {}
    project = data.get("project", "default")
    session_id = _get_session(project)

    if not session_id:
        return jsonify({"error": "no active session"}), 400

    question = data.get("question", "")
    if not question:
        return jsonify({"error": "question required"}), 400

    page_scan = data.get("pageScan")
    screenshot = data.get("screenshot")
    permissions = data.get("permissions", "readwrite")
    tools = _permissions_to_tools(permissions)

    # Build prompt (same logic as /ask)
    screenshot_path = None
    if screenshot:
        import base64, tempfile
        header, b64data = screenshot.split(",", 1) if "," in screenshot else ("", screenshot)
        img_bytes = base64.b64decode(b64data)
        tmp = tempfile.NamedTemporaryFile(suffix=".png", prefix="aprova_screenshot_", delete=False,
                                          dir=str(PROJECT_DIR))
        tmp.write(img_bytes)
        tmp.close()
        screenshot_path = tmp.name

    if screenshot_path:
        ss_path = screenshot_path.replace("\\", "/")
        scan_section = ""
        if page_scan:
            scan_section = (
                f"\n\nDados estruturados da página (scan DOM):\n"
                f"{json.dumps(page_scan, ensure_ascii=False, indent=2)}\n"
            )
        prompt = (
            f"{question}\n\n"
            f"PRIMEIRO: lê o screenshot da página com Read file_path=\"{ss_path}\"\n"
            f"É uma imagem PNG do ecrã do utilizador. Analisa o que vês."
            f"{scan_section}\n"
            "[Instrução: responde de forma concisa e directa. "
            "Não repitas informação já dada nesta sessão. "
            "Usa markdown para formatar.]"
        )
    elif page_scan:
        prompt = f"""{question}

Estado actual da página:
{json.dumps(page_scan, ensure_ascii=False, indent=2)}

[Instrução: responde de forma concisa e directa.
Não repitas informação já dada nesta sessão.
Se o pedido envolve preencher/alterar campos, devolve JSON puro:
{{"actions": [...], "alerts": [...], "answer": "..."}}
Cada acção: {{"type": "fill_text|select_option|click_radio|click_checkbox|click_button", "selector": "...", "value": "...", "description": "..."}}
Se o pedido é só uma pergunta, responde normalmente em markdown.]"""
    else:
        prompt = (
            f"{question}\n\n"
            "[Instrução: responde de forma concisa e directa. "
            "Não repitas informação já dada nesta sessão. "
            "Usa markdown para formatar.]"
        )

    def generate():
        import queue
        from claude_code_sdk import query as sdk_query, ClaudeCodeOptions

        options = ClaudeCodeOptions(
            allowed_tools=tools,
            cwd=str(PROJECT_DIR),
        )
        if session_id:
            options.resume = session_id

        q = queue.Queue()
        _SENTINEL = object()

        async def run():
            try:
                async for msg in sdk_query(prompt=prompt, options=options):
                    if isinstance(msg, _SkippedMessage):
                        continue
                    cls = type(msg).__name__

                    if cls == "AssistantMessage":
                        content = getattr(msg, "content", None)
                        if content and isinstance(content, list):
                            for block in content:
                                btype = type(block).__name__
                                if btype == "ThinkingBlock":
                                    thinking = getattr(block, "text", "")
                                    if thinking:
                                        q.put({"type": "step", "text": thinking[:200]})
                                elif btype == "ToolUseBlock":
                                    tool_name = getattr(block, "name", "?")
                                    tool_input = getattr(block, "input", {}) or {}
                                    desc = tool_name
                                    if tool_name in ("Read", "Glob", "Grep"):
                                        target = (tool_input.get("file_path")
                                                  or tool_input.get("pattern")
                                                  or tool_input.get("path", ""))
                                        if target:
                                            target = str(target).replace(str(PROJECT_DIR), ".")
                                            desc = f"{tool_name} {target}"
                                    q.put({"type": "step", "text": desc})
                                elif hasattr(block, "text") and block.text:
                                    q.put({"type": "text", "text": block.text})

                    elif cls == "ResultMessage":
                        result = getattr(msg, "result", "")
                        if result:
                            q.put({"type": "result", "text": result})
            except Exception as e:
                q.put({"type": "error", "text": str(e)})
            finally:
                q.put(_SENTINEL)

        # Run the async SDK query in a background thread
        def _run_in_thread():
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(run())
            finally:
                loop.close()

        t = threading.Thread(target=_run_in_thread, daemon=True)
        t.start()

        try:
            while True:
                item = q.get(timeout=120)
                if item is _SENTINEL:
                    break
                yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'text': str(e)}, ensure_ascii=False)}\n\n"
        finally:
            if screenshot_path:
                try:
                    os.unlink(screenshot_path)
                except OSError:
                    pass
        yield "data: [DONE]\n\n"

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/validate", methods=["POST"])
def validate():
    """Validate current form values."""
    data = request.json or {}
    project = data.get("project", "default")
    session_id = _get_session(project)

    if not session_id:
        return jsonify({"error": "no active session"}), 400

    page_scan = data.get("pageScan", {})
    permissions = data.get("permissions", "readwrite")
    tools = _permissions_to_tools(permissions)

    prompt = f"""Valida os valores actuais dos campos deste formulário.

Estado actual:
{json.dumps(page_scan, ensure_ascii=False, indent=2)}

Para cada campo, verifica se o valor está correcto face aos dados do projecto.
Devolve JSON puro: {{"validations": [{{"field": "...", "status": "ok|warning|error", "message": "..."}}], "summary": "..."}}"""

    try:
        result, _, steps = _run_async(_sdk_query(prompt, session_id=session_id, allowed_tools=tools))
        parsed = _extract_json(result)
        parsed["steps"] = steps
        return jsonify(parsed)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# JSON extraction helper
# ---------------------------------------------------------------------------

def _extract_json(text):
    """Extract JSON from Claude response (may have markdown fences or extra text)."""
    import re
    # Try direct parse
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        pass
    # Try to find JSON in markdown code block
    m = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    # Try to find first { ... } block
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    # Return as-is wrapped
    return {"raw": text}


# ---------------------------------------------------------------------------
# Flask runner
# ---------------------------------------------------------------------------

def run_flask():
    """Run Flask server (blocking) via waitress production WSGI server."""
    from waitress import serve
    log(f"waitress serving on {_C}http://{HOST}:{PORT}{_R}", "ok")
    serve(app, host=HOST, port=PORT,
          threads=max(8, os.cpu_count() * 2),
          channel_timeout=120)


# ---------------------------------------------------------------------------
# System Tray (optional, with pystray)
# ---------------------------------------------------------------------------

def run_with_tray():
    """Run with system tray icon."""
    try:
        import pystray
        from PIL import Image, ImageDraw
    except ImportError:
        log("pystray/pillow not installed — falling back to terminal mode", "warn")
        run_flask()
        return

    class BridgeApp:
        def __init__(self):
            self.server_thread = None
            self.running = False
            self.icon = None

        def _make_icon(self, running=False):
            # Load the real extension icon
            icon_path = Path(__file__).parent / ".." / "chrome-extension" / "icons" / "icon48.png"
            try:
                img = Image.open(icon_path).resize((64, 64), Image.LANCZOS).convert("RGBA")
            except Exception:
                img = Image.new("RGBA", (64, 64), color="#0f0f1a")
            # Draw a small status dot in the bottom-right corner
            draw = ImageDraw.Draw(img)
            dot_color = "#4ade80" if running else "#ef4444"
            draw.ellipse([46, 46, 62, 62], fill=dot_color, outline="#0f0f1a", width=2)
            return img

        def create_icon(self):
            menu = pystray.Menu(
                pystray.MenuItem("Start Server", self.start_server, default=True),
                pystray.MenuItem("Stop Server", self.stop_server),
                pystray.MenuItem("Status", self.show_status),
                pystray.MenuItem(pystray.Menu.SEPARATOR, None),
                pystray.MenuItem("Quit", self.quit),
            )
            self.icon = pystray.Icon(
                "aprova-bridge", self._make_icon(running=False), "Aprova.ai Bridge", menu
            )
            return self.icon

        def start_server(self, icon=None, item=None):
            if not self.running:
                self.running = True
                self.server_thread = threading.Thread(target=run_flask, daemon=True)
                self.server_thread.start()
                if self.icon:
                    self.icon.icon = self._make_icon(running=True)
                    self.icon.notify("Aprova.ai Bridge ligado (localhost:9090)")

        def stop_server(self, icon=None, item=None):
            self.running = False
            if self.icon:
                self.icon.icon = self._make_icon(running=False)
                self.icon.notify("Aprova.ai Bridge desligado")

        def show_status(self, icon=None, item=None):
            s = "Ligado" if self.running else "Desligado"
            active = ", ".join(sessions.keys()) or "Nenhuma"
            if self.icon:
                self.icon.notify(f"Status: {s}\nSessoes: {active}")

        def quit(self, icon=None, item=None):
            self.running = False
            if self.icon:
                self.icon.stop()

    bridge_app = BridgeApp()
    icon = bridge_app.create_icon()
    # Auto-start server on launch
    bridge_app.start_server()
    icon.run()


# ---------------------------------------------------------------------------
# Console output helpers
# ---------------------------------------------------------------------------

# ANSI colour shortcuts
_R  = "\033[0m"       # reset
_B  = "\033[1m"       # bold
_DM = "\033[2m"       # dim
_G  = "\033[38;5;78m" # accent green  (#4ade80-ish)
_C  = "\033[38;5;39m" # cyan
_Y  = "\033[38;5;220m" # yellow
_RD = "\033[38;5;196m" # red
_W  = "\033[97m"      # bright white
_BG = "\033[48;5;234m" # dark bg bar


def _banner(mode):
    """Print a styled startup banner."""
    if sys.platform == "win32":
        os.system("")  # triggers VT100 mode
        # Force UTF-8 output so box-drawing chars work
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    modes = {"tray": f"{_Y}tray{_R}", "headless": f"{_C}headless{_R}", "daemon": f"{_G}daemon{_R}"}
    m = modes.get(mode, mode)
    proj = str(PROJECT_DIR).replace("\\", "/")
    print()
    print(f"  {_BG}{_G}{_B}  \u2554{'═'*38}\u2557  {_R}")
    print(f"  {_BG}{_G}{_B}  \u2551        {_W}Aprova{_G}.ai {_W}Bridge Server{_G}       \u2551  {_R}")
    print(f"  {_BG}{_G}{_B}  \u2551  {_DM}by Rui Barbosa @rmblda 2026{_G}{_B}         \u2551  {_R}")
    print(f"  {_BG}{_G}{_B}  \u255a{'═'*38}\u255d  {_R}")
    print()
    verbose_tag = f"  {_Y}verbose{_R}" if VERBOSE else ""
    print(f"  {_DM}mode       {_R} {m}{verbose_tag}")
    print(f"  {_DM}project    {_R} {_W}{proj}{_R}")
    print(f"  {_DM}endpoint   {_R} {_C}http://{HOST}:{PORT}{_R}")
    print(flush=True)


def log(msg, level="info"):
    """Pretty-print a bridge log line."""
    ts = time.strftime("%H:%M:%S")
    if level == "ok":
        tag = f"{_G}  OK {_R}"
    elif level == "warn":
        tag = f"{_Y}WARN {_R}"
    elif level == "err":
        tag = f"{_RD} ERR {_R}"
    else:
        tag = f"{_C}INFO {_R}"
    print(f"  {_DM}{ts}{_R}  {tag} {msg}", flush=True)


# ---------------------------------------------------------------------------
# Daemon mode
# ---------------------------------------------------------------------------

def run_daemon():
    """Re-launch this script as a detached background process (Windows)."""
    import subprocess

    script = Path(__file__).resolve()
    # Spawn headless in a detached, windowless process
    CREATE_NO_WINDOW = 0x08000000
    DETACHED_PROCESS = 0x00000008
    proc = subprocess.Popen(
        [sys.executable, str(script), "--headless"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW | DETACHED_PROCESS,
    )
    log(f"daemon started  {_DM}PID {proc.pid}{_R}", "ok")


# ---------------------------------------------------------------------------
# Instance detection
# ---------------------------------------------------------------------------

def _find_running_instance():
    """Check if another bridge is already listening on HOST:PORT.
    Returns the PID of the existing process or None."""
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.settimeout(1)
        sock.connect((HOST, PORT))
        sock.close()
    except (ConnectionRefusedError, OSError):
        return None

    # Port is open — try to confirm it's our bridge
    try:
        import urllib.request
        resp = urllib.request.urlopen(f"http://{HOST}:{PORT}/status", timeout=2)
        data = json.loads(resp.read())
        if data.get("status") != "ok":
            return None
    except Exception:
        return None

    # Find the PID that owns the port
    try:
        import subprocess
        out = subprocess.check_output(
            ["netstat", "-ano"], text=True, creationflags=0x08000000
        )
        for line in out.splitlines():
            if f"{HOST}:{PORT}" in line and "LISTENING" in line:
                return int(line.strip().split()[-1])
    except Exception:
        pass

    return -1  # running but PID unknown


# ---------------------------------------------------------------------------
# RPA — Template save/load endpoints
# ---------------------------------------------------------------------------

@app.route("/template/save", methods=["POST"])
def save_template():
    """Save a form template JSON to the project folder."""
    data = request.json or {}
    project = data.get("project", "default")
    template = data.get("template")
    if not template:
        return jsonify({"error": "No template provided"}), 400

    dest = PROJECT_DIR / "projects" / project / "candidatura" / "form-template.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(template, ensure_ascii=False, indent=2), encoding="utf-8")
    return jsonify({"ok": True, "path": str(dest)})


@app.route("/template/load", methods=["GET"])
def load_template():
    """Load a saved form template from the project folder."""
    project = request.args.get("project", "default")
    src = PROJECT_DIR / "projects" / project / "candidatura" / "form-template.json"
    if not src.exists():
        return jsonify({"error": "Template not found"}), 404
    template = json.loads(src.read_text(encoding="utf-8"))
    return jsonify(template)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    args = sys.argv[1:]
    daemon   = "-d" in args or "--daemon" in args
    headless = "--headless" in args
    force    = "-f" in args or "--force" in args
    VERBOSE  = "-v" in args or "--verbose" in args

    # --project-dir <path>
    for i, a in enumerate(args):
        if a == "--project-dir" and i + 1 < len(args):
            PROJECT_DIR = Path(args[i + 1])
            break

    BROWSER_STATE_FILE = PROJECT_DIR / "tmp" / ".browser-state.json"

    if daemon:
        mode = "daemon"
    elif headless:
        mode = "headless"
    else:
        mode = "tray"

    _banner(mode)

    existing_pid = _find_running_instance()
    if existing_pid:
        pid_str = str(existing_pid) if existing_pid > 0 else "unknown"
        if force and existing_pid > 0:
            log(f"killing existing instance  {_DM}PID {pid_str}{_R}", "warn")
            try:
                os.kill(existing_pid, 9)
                time.sleep(0.5)
            except OSError:
                pass
            log("previous instance terminated", "ok")
        else:
            log(f"bridge already running  {_DM}PID {pid_str}{_R}", "warn")
            if not force:
                log("use the tray icon to quit, or restart with -f to force", "warn")
            else:
                log("could not determine PID to kill — stop it manually", "err")
            sys.exit(1)

    if daemon:
        run_daemon()
    elif headless:
        run_flask()
    else:
        run_with_tray()
