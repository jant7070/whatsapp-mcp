import os
import sys
from pathlib import Path

# Required env vars must be set before server.py is imported.
os.environ.setdefault("BRIDGE_API_KEY", "x" * 32)
os.environ.setdefault("DEPLOYMENT_MODE", "local")
os.environ.setdefault("BRIDGE_URL", "http://test-bridge:3001")

# Ensure mcp_server/ is on sys.path so `import server` works.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
