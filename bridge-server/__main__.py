"""Allow running as: py -3 -m bridge_server"""
from aprova_ai_bridge import *
import sys

if __name__ == "__main__":
    headless = "--headless" in sys.argv
    print(f"[bridge] Aprova.ai Bridge Server")
    print(f"[bridge] Project dir: {PROJECT_DIR}")
    print(f"[bridge] Listening on {HOST}:{PORT}")

    if headless:
        run_flask()
    else:
        run_with_tray()
