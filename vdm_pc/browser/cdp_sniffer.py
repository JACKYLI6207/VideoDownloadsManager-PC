"""Chrome DevTools Protocol 網路嗅探 + 頁面腳本注入（對齊擴充嗅探）。"""
from __future__ import annotations

import json
import threading
import time
import urllib.request
from typing import Callable

import websocket

from vdm_pc.browser.content_sniffer_js import SNIFFER_SCRIPT
from vdm_pc.browser.detector import is_likely_ad_url, is_video_url

_BINDING = "vdmSniff"


class ChromeCdpSniffer:
    def __init__(
        self,
        port: int,
        *,
        on_request: Callable[[str, dict, str, str], None],
        on_response: Callable[[str, dict, str, str], None],
    ) -> None:
        self.port = port
        self.on_request = on_request
        self.on_response = on_response
        self._ws: websocket.WebSocketApp | None = None
        self._thread: threading.Thread | None = None
        self._active = False
        self._msg_id = 0
        self._lock = threading.Lock()
        self._main_session: str | None = None
        self._pending_url: str | None = None
        self._page_urls: dict[str, str] = {}
        self._attached_targets: set[str] = set()
        self._injected_sessions: set[str] = set()

    def start(self) -> None:
        if self._active:
            return
        self._active = True
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._active = False
        if self._ws is not None:
            try:
                self._ws.close()
            except Exception:
                pass
            self._ws = None

    def navigate(self, url: str) -> None:
        self._pending_url = url
        session = self._pick_navigate_session()
        if session:
            self._pending_url = None
            self._send("Page.navigate", {"url": url}, session=session)

    def _pick_navigate_session(self) -> str | None:
        if self._main_session:
            return self._main_session
        for session, page_url in self._page_urls.items():
            if page_url.startswith(("http://", "https://", "about:")):
                return session
        return next(iter(self._page_urls), None)

    def _run_loop(self) -> None:
        while self._active:
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{self.port}/json/version", timeout=3
                ) as res:
                    ver = json.loads(res.read().decode("utf-8"))
                ws_url = ver["webSocketDebuggerUrl"]
            except OSError:
                time.sleep(0.3)
                continue

            self._attached_targets.clear()
            self._injected_sessions.clear()
            self._main_session = None
            self._page_urls.clear()

            self._ws = websocket.WebSocketApp(
                ws_url,
                on_open=self._on_open,
                on_message=self._on_message,
                on_error=lambda _ws, _err: None,
                on_close=lambda _ws, _code, _msg: None,
            )
            self._ws.run_forever(ping_interval=20, ping_timeout=10)
            if self._active:
                time.sleep(0.5)

    def _on_open(self, _ws) -> None:
        self._send("Target.setAutoAttach", {
            "autoAttach": True,
            "waitForDebuggerOnStart": False,
            "flatten": True,
        })
        threading.Thread(target=self._attach_existing_targets, daemon=True).start()

    def _attach_existing_targets(self) -> None:
        time.sleep(0.2)
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{self.port}/json/list", timeout=3
            ) as res:
                targets = json.loads(res.read().decode("utf-8"))
        except OSError:
            return
        for target in targets:
            target_id = target.get("id")
            target_type = target.get("type")
            url = target.get("url") or ""
            if not target_id or target_type not in ("page", "iframe"):
                continue
            if url.startswith("chrome://") or url.startswith("chrome-extension://"):
                continue
            if target_id in self._attached_targets:
                continue
            self._attached_targets.add(target_id)
            self._send("Target.attachToTarget", {
                "targetId": target_id,
                "flatten": True,
            })

    def _send(self, method: str, params: dict | None = None, *, session: str | None = None) -> None:
        with self._lock:
            self._msg_id += 1
            msg_id = self._msg_id
        payload: dict = {"id": msg_id, "method": method, "params": params or {}}
        if session:
            payload["sessionId"] = session
        if self._ws is not None:
            try:
                self._ws.send(json.dumps(payload))
            except Exception:
                pass

    def _inject_sniffer(self, session: str) -> None:
        if session in self._injected_sessions:
            return
        self._injected_sessions.add(session)
        self._send("Runtime.enable", session=session)
        self._send("Page.enable", session=session)
        self._send("Runtime.addBinding", {"name": _BINDING}, session=session)
        self._send(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": SNIFFER_SCRIPT},
            session=session,
        )
        self._send(
            "Runtime.evaluate",
            {"expression": SNIFFER_SCRIPT, "userGesture": False},
            session=session,
        )

    def _enable_network(self, session: str, page_url: str = "") -> None:
        if page_url:
            self._page_urls[session] = page_url
        if self._main_session is None and (
            not page_url
            or page_url.startswith(("http://", "https://", "about:"))
            or page_url == ""
        ):
            self._main_session = session
        self._inject_sniffer(session)
        self._send("Network.enable", {"maxPostDataSize": 65536}, session=session)

    def _handle_sniff_payload(self, payload: str, session: str | None) -> None:
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            return
        url = str(data.get("url") or "")
        page_url = str(data.get("pageUrl") or self._page_urls.get(session or "", ""))
        self._emit_if_video(url, {}, page_url)

    def _emit_if_video(
        self, url: str, headers: dict, page_url: str, *, from_response: bool = False
    ) -> None:
        if not url or is_likely_ad_url(url):
            return
        if not is_video_url(url):
            return
        if from_response:
            self.on_response(url, headers, page_url, "")
        else:
            self.on_request(url, headers, page_url, "")

    def _on_message(self, _ws, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return

        method = msg.get("method")
        session = msg.get("sessionId")
        params = msg.get("params") or {}

        if method == "Target.attachedToTarget":
            child_session = params.get("sessionId")
            info = params.get("targetInfo") or {}
            if not child_session:
                return
            if info.get("type") not in ("page", "iframe"):
                return
            page_url = info.get("url") or ""
            if page_url.startswith(("chrome://", "chrome-extension://")):
                return
            target_id = info.get("targetId") or ""
            if target_id:
                self._attached_targets.add(target_id)
            self._enable_network(child_session, page_url)
            pending = self._pending_url
            nav_session = self._pick_navigate_session()
            if pending and nav_session == child_session:
                self._pending_url = None
                self._send("Page.navigate", {"url": pending}, session=child_session)
            return

        if method == "Page.frameNavigated":
            frame = params.get("frame") or {}
            url = frame.get("url") or ""
            if session and url and not url.startswith(("chrome://", "chrome-extension://")):
                self._page_urls[session] = url
                if self._main_session is None and url.startswith(("http://", "https://")):
                    self._main_session = session
            return

        if method == "Runtime.bindingCalled":
            if params.get("name") == _BINDING:
                self._handle_sniff_payload(str(params.get("payload") or ""), session)
            return

        if method == "Network.requestWillBeSent":
            req = params.get("request") or {}
            url = req.get("url") or ""
            headers = {str(k).lower(): str(v) for k, v in (req.get("headers") or {}).items()}
            page_url = params.get("documentURL") or self._page_urls.get(session or "", "")
            self._emit_if_video(url, headers, page_url)
            return

        if method == "Network.responseReceived":
            resp = params.get("response") or {}
            url = resp.get("url") or ""
            headers = {str(k).lower(): str(v) for k, v in (resp.get("headers") or {}).items()}
            page_url = self._page_urls.get(session or "", "")
            self._emit_if_video(url, headers, page_url, from_response=True)
