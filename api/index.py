import os
import sys

cur_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.abspath(os.path.join(cur_dir, ".."))

for p in [root_dir, cur_dir]:
    if p not in sys.path:
        sys.path.insert(0, p)

try:
    from server import app
except Exception as e:
    import traceback
    err_tb = traceback.format_exc()
    from fastapi import FastAPI
    from fastapi.responses import HTMLResponse
    app = FastAPI()

    @app.api_route("/{path_name:path}", methods=["GET", "POST", "PUT", "DELETE"])
    def catch_all(path_name: str):
        return HTMLResponse(f"<h3>Server Startup Error</h3><pre>{err_tb}</pre>", status_code=500)
