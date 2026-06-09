"""Video Downloads Manager PC — 獨立桌面版入口。"""
import sys

from PyQt6.QtWidgets import QApplication

from vdm_pc.app import MainWindow
from vdm_pc.config import load_settings
from vdm_pc.cpu_limit import apply_cpu_cap
from vdm_pc.download.engine import DownloadEngine
from vdm_pc.log_bus import LogBus


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Video Downloads Manager PC")
    app.setOrganizationName("VDM")

    settings = load_settings()
    log_bus = LogBus()
    ok, cpu_msg = apply_cpu_cap(50)
    if ok:
        log_bus.push("info", cpu_msg)
    else:
        log_bus.push("warn", f"CPU 上限未生效：{cpu_msg}")
    engine = DownloadEngine(settings, log_bus)

    window = MainWindow(settings, engine, log_bus)
    window.resize(980, 720)
    window.show()

    code = app.exec()
    engine.shutdown()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
