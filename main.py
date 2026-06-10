"""Video Downloads Manager PC — 獨立桌面版入口。"""
import sys

# PyInstaller 需於啟動時載入 Selenium 子模組，否則 BiDi 擴充安裝會缺模組
if getattr(sys, "frozen", False):
    import selenium.webdriver.chrome.webdriver  # noqa: F401
    import selenium.webdriver.common.bidi.webextension  # noqa: F401

if sys.platform == "win32":
    try:
        import ctypes

        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
            "VideoDownloadsManager.PC.1"
        )
    except (AttributeError, OSError):
        pass

from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import QApplication

from vdm_pc.app import MainWindow
from vdm_pc.bridge_server import PcBridgeServer
from vdm_pc.config import app_icon_path, load_settings
from vdm_pc.cpu_limit import apply_cpu_cap
from vdm_pc.download.engine import DownloadEngine
from vdm_pc.log_bus import LogBus


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Video Downloads Manager PC")
    app.setOrganizationName("VDM")
    icon_file = app_icon_path()
    if icon_file:
        app.setWindowIcon(QIcon(str(icon_file)))

    settings = load_settings()
    log_bus = LogBus()
    ok, cpu_msg = apply_cpu_cap(50)
    if ok:
        log_bus.push("info", cpu_msg)
    else:
        log_bus.push("warn", f"CPU 上限未生效：{cpu_msg}")
    engine = DownloadEngine(settings, log_bus)

    window = MainWindow(settings, engine, log_bus)
    bridge = PcBridgeServer(lambda tasks: window.browser_panel.tasks_received.emit(tasks))
    bridge.start()
    log_bus.push("info", "擴充橋接服務已啟動（127.0.0.1:18429）")
    window.resize(980, 720)
    window.show()

    code = app.exec()
    bridge.stop()
    engine.shutdown()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
