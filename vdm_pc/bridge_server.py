"""接收擴充 POST 的待下載任務（localhost HTTP）。"""

from __future__ import annotations



import json

import threading

from http.server import BaseHTTPRequestHandler, HTTPServer

from typing import Callable



BRIDGE_PORT = 18429





class PcBridgeServer:

    def __init__(

        self,

        on_tasks: Callable[[list[dict]], None] | None = None,

    ) -> None:

        self._on_tasks = on_tasks

        self._httpd: HTTPServer | None = None

        self._thread: threading.Thread | None = None



    def set_callbacks(

        self,

        on_tasks: Callable[[list[dict]], None] | None = None,

    ) -> None:

        if on_tasks is not None:

            self._on_tasks = on_tasks



    def start(self) -> None:

        if self._httpd is not None:

            return

        on_tasks = self._on_tasks



        class Handler(BaseHTTPRequestHandler):

            def log_message(self, _format: str, *_args) -> None:

                return



            def _send_json(self, status: int, payload: dict) -> None:

                body = json.dumps(payload).encode("utf-8")

                self.send_response(status)

                self.send_header("Content-Type", "application/json")

                self.send_header("Access-Control-Allow-Origin", "*")

                self.end_headers()

                self.wfile.write(body)



            def _read_json(self) -> dict:

                length = int(self.headers.get("Content-Length", 0))

                body = self.rfile.read(length)

                data = json.loads(body.decode("utf-8"))

                if not isinstance(data, dict):

                    raise ValueError("需要 JSON 物件")

                return data



            def do_OPTIONS(self) -> None:

                self.send_response(204)

                self.send_header("Access-Control-Allow-Origin", "*")

                self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

                self.send_header("Access-Control-Allow-Headers", "Content-Type")

                self.end_headers()



            def do_GET(self) -> None:

                if self.path == "/health":

                    self._send_json(200, {"ok": True, "service": "vdm-pc-bridge"})

                    return

                self.send_error(404)



            def do_POST(self) -> None:

                try:

                    if self.path == "/push-tasks":

                        data = self._read_json()

                        tasks = data.get("tasks") if isinstance(data, dict) else data

                        if not isinstance(tasks, list):

                            raise ValueError("缺少 tasks 列表")

                        if on_tasks:

                            on_tasks(tasks)

                        self._send_json(200, {"ok": True, "count": len(tasks)})

                        return



                    self.send_error(404)

                except Exception as exc:  # noqa: BLE001

                    msg = str(exc).encode("utf-8", errors="replace")

                    self.send_response(400)

                    self.send_header("Content-Type", "text/plain; charset=utf-8")

                    self.end_headers()

                    self.wfile.write(msg)



        self._httpd = HTTPServer(("127.0.0.1", BRIDGE_PORT), Handler)

        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

        self._thread.start()



    def stop(self) -> None:

        if self._httpd is None:

            return

        self._httpd.shutdown()

        self._httpd.server_close()

        self._httpd = None

        self._thread = None

