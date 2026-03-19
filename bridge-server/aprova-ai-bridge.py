#!/usr/bin/env python3
"""
Aprova.ai Bridge Server — Flask + Claude Agent SDK
Connects Chrome Extension to Claude Code with persistent sessions.

Usage:
    py -3 aprova-ai-bridge.py              # normal mode (with system tray icon)
    py -3 aprova-ai-bridge.py --headless   # no tray icon, terminal mode

Author: Rui Barbosa @rmblda 2026
"""

import asyncio
import json
import os
import sys
import threading
import time
from pathlib import Path

from flask import Flask, request, jsonify
from flask_cors import CORS

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PROJECT_DIR = Path(r"C:\trabalhos\aprova.ai")
HOST = "127.0.0.1"
PORT = 9090

app = Flask(__name__)
# CORS: allow Chrome extension origin (update ID after install)
CORS(app, resources={r"/*": {"origins": ["chrome-extension://*", "http://localhost:*"]}})

# Active sessions: project_slug -> { session_id, mode, created }
sessions = {}

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


async def _sdk_query(prompt, session_id=None, allowed_tools=None):
    """Send a prompt to Claude Agent SDK and return the result text + session_id."""
    from claude_code_sdk import query as sdk_query, ClaudeCodeOptions

    options = ClaudeCodeOptions(
        allowed_tools=allowed_tools or ["Read", "Glob", "Grep"],
        cwd=str(PROJECT_DIR),
    )
    if session_id:
        options.resume = session_id

    result_text = ""
    new_session_id = session_id

    async for msg in sdk_query(prompt=prompt, options=options):
        # Capture session_id from init message
        if hasattr(msg, "session_id") and msg.session_id:
            new_session_id = msg.session_id
        # Capture result text
        if hasattr(msg, "type"):
            if msg.type == "result":
                result_text = getattr(msg, "result", "") or ""
                if not new_session_id:
                    new_session_id = getattr(msg, "session_id", None)
            elif msg.type == "assistant":
                # Accumulate assistant text for intermediate messages
                content = getattr(msg, "content", None)
                if content and isinstance(content, list):
                    for block in content:
                        if hasattr(block, "text"):
                            result_text = block.text

    return result_text, new_session_id


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


# ---------------------------------------------------------------------------
# Routes — Session Management
# ---------------------------------------------------------------------------

@app.route("/session/list", methods=["GET"])
def list_sessions():
    """List recent Claude Code sessions from local storage."""
    sessions_dir = Path.home() / ".claude" / "projects" / "C--trabalhos-aprova-ai" / "sessions"
    recent = []

    if sessions_dir.exists():
        files = sorted(sessions_dir.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True)
        for f in files[:10]:
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                recent.append({
                    "sessionId": data.get("id", f.stem),
                    "created": data.get("created"),
                    "lastMessage": (
                        data.get("messages", [{}])[-1].get("content", "")[:100]
                        if data.get("messages") else ""
                    ),
                })
            except Exception:
                pass

    return jsonify({"sessions": recent})


@app.route("/session/start", methods=["POST"])
def start_session():
    """Create a new Claude SDK session for a project."""
    data = request.json or {}
    project = data.get("project", "default")

    init_prompt = f"""Vais ajudar a preencher o formulário de candidatura online.
Projecto: projects/{project}/
Lê o _projeto.md, o guia de preenchimento (se existir), e os dados da empresa.
Quando te enviar campos do formulário, devolve JSON com os valores a preencher.
Formato de resposta SEMPRE em JSON puro (sem markdown fences).
Confirma que estás pronto."""

    try:
        result, sid = _run_async(_sdk_query(init_prompt))
        sessions[project] = {
            "session_id": sid,
            "mode": "created",
            "created": time.time(),
        }
        return jsonify({"sessionId": sid, "status": "ready", "message": result})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/session/attach", methods=["POST"])
def attach_session():
    """Attach to an existing Claude Code session by ID."""
    data = request.json or {}
    session_id = data.get("sessionId")
    project = data.get("project", "default")

    if not session_id:
        return jsonify({"error": "sessionId required"}), 400

    sessions[project] = {
        "session_id": session_id,
        "mode": "attached",
        "created": time.time(),
    }
    return jsonify({"status": "attached", "sessionId": session_id})


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
        result, _ = _run_async(_sdk_query(prompt, session_id=session_id))
        # Try to parse JSON from result
        parsed = _extract_json(result)
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
        result, _ = _run_async(_sdk_query(prompt, session_id=session_id))
        parsed = _extract_json(result)
        return jsonify(parsed)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/ask", methods=["POST"])
def ask():
    """Free-form question to Claude ('Ask Boris')."""
    data = request.json or {}
    project = data.get("project", "default")
    session_id = _get_session(project)

    if not session_id:
        return jsonify({"error": "no active session"}), 400

    question = data.get("question", "")
    if not question:
        return jsonify({"error": "question required"}), 400

    try:
        result, _ = _run_async(_sdk_query(question, session_id=session_id))
        return jsonify({"answer": result})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/validate", methods=["POST"])
def validate():
    """Validate current form values."""
    data = request.json or {}
    project = data.get("project", "default")
    session_id = _get_session(project)

    if not session_id:
        return jsonify({"error": "no active session"}), 400

    page_scan = data.get("pageScan", {})

    prompt = f"""Valida os valores actuais dos campos deste formulário.

Estado actual:
{json.dumps(page_scan, ensure_ascii=False, indent=2)}

Para cada campo, verifica se o valor está correcto face aos dados do projecto.
Devolve JSON puro: {{"validations": [{{"field": "...", "status": "ok|warning|error", "message": "..."}}], "summary": "..."}}"""

    try:
        result, _ = _run_async(_sdk_query(prompt, session_id=session_id))
        parsed = _extract_json(result)
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
    """Run Flask server (blocking)."""
    app.run(host=HOST, port=PORT, debug=False, use_reloader=False)


# ---------------------------------------------------------------------------
# System Tray (optional, with pystray)
# ---------------------------------------------------------------------------

def run_with_tray():
    """Run with system tray icon."""
    try:
        import pystray
        from PIL import Image, ImageDraw
    except ImportError:
        print("[bridge] pystray/pillow not installed — running in terminal mode")
        run_flask()
        return

    class BridgeApp:
        def __init__(self):
            self.server_thread = None
            self.running = False
            self.icon = None

        def _make_icon(self, color):
            img = Image.new("RGB", (64, 64), color=color)
            draw = ImageDraw.Draw(img)
            # Draw "A" for Aprova
            draw.text((20, 15), "A", fill="white")
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
                "aprova-bridge", self._make_icon("#cc3333"), "Aprova.ai Bridge", menu
            )
            return self.icon

        def start_server(self, icon=None, item=None):
            if not self.running:
                self.running = True
                self.server_thread = threading.Thread(target=run_flask, daemon=True)
                self.server_thread.start()
                if self.icon:
                    self.icon.icon = self._make_icon("#33aa33")
                    self.icon.notify("Aprova.ai Bridge ligado (localhost:9090)")

        def stop_server(self, icon=None, item=None):
            self.running = False
            if self.icon:
                self.icon.icon = self._make_icon("#cc3333")
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
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    headless = "--headless" in sys.argv
    print(f"[bridge] Aprova.ai Bridge Server")
    print(f"[bridge] Project dir: {PROJECT_DIR}")
    print(f"[bridge] Listening on {HOST}:{PORT}")

    if headless:
        run_flask()
    else:
        run_with_tray()
