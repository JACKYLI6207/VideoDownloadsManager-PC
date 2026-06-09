"""Windows 程序 CPU 使用率硬上限（Job Object + 親和力備援）。"""
from __future__ import annotations

import ctypes
import os
import sys
from ctypes import wintypes

_JOB_HANDLE: int | None = None
_APPLIED_VIA: str = ""

JobObjectCpuRateControlInformation = 15
JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1
JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4

PROCESS_SET_QUOTA = 0x0100
PROCESS_TERMINATE = 0x0001


class JOBOBJECT_CPU_RATE_CONTROL_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("ControlFlags", wintypes.DWORD),
        ("CpuRate", wintypes.DWORD),
    ]


def _kernel32():
    return ctypes.windll.kernel32


def _open_process(pid: int) -> int | None:
    handle = _kernel32().OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
    return handle or None


def _assign_pid_to_job(job: int, pid: int) -> bool:
    proc = _open_process(pid)
    if not proc:
        return False
    try:
        return bool(_kernel32().AssignProcessToJobObject(job, proc))
    finally:
        _kernel32().CloseHandle(proc)


def _apply_affinity_cap(percent: int) -> bool:
    cores = os.cpu_count() or 1
    allowed = max(1, round(cores * percent / 100))
    mask = (1 << allowed) - 1
    proc = _open_process(_kernel32().GetCurrentProcessId())
    if not proc:
        return False
    try:
        ok = bool(_kernel32().SetProcessAffinityMask(proc, mask))
    finally:
        _kernel32().CloseHandle(proc)
    return ok


def apply_cpu_cap(percent: int = 50) -> tuple[bool, str]:
    """將目前行程（含子行程）CPU 硬上限設為 percent%（僅 Windows）。"""
    global _JOB_HANDLE, _APPLIED_VIA
    if sys.platform != "win32":
        return False, "非 Windows，略過 CPU 上限"

    pct = max(1, min(100, int(percent)))
    kernel32 = _kernel32()

    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        err = kernel32.GetLastError()
        if _apply_affinity_cap(pct):
            _APPLIED_VIA = "affinity"
            return True, f"Job 建立失敗（{err}），已改以 CPU 親和力限制約 {pct}%"
        return False, f"Job 建立失敗（{err}）"

    info = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION()
    info.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP
    info.CpuRate = pct * 100

    if not kernel32.SetInformationJobObject(
        job,
        JobObjectCpuRateControlInformation,
        ctypes.byref(info),
        ctypes.sizeof(info),
    ):
        err = kernel32.GetLastError()
        kernel32.CloseHandle(job)
        if _apply_affinity_cap(pct):
            _APPLIED_VIA = "affinity"
            return True, f"Job 設定失敗（{err}），已改以 CPU 親和力限制約 {pct}%"
        return False, f"Job 設定失敗（{err}）"

    pid = kernel32.GetCurrentProcessId()
    if not _assign_pid_to_job(job, pid):
        err = kernel32.GetLastError()
        kernel32.CloseHandle(job)
        if _apply_affinity_cap(pct):
            _APPLIED_VIA = "affinity"
            return True, f"Job 綁定失敗（{err}），已改以 CPU 親和力限制約 {pct}%"
        return False, f"Job 綁定失敗（{err}）"

    _JOB_HANDLE = job
    _APPLIED_VIA = "job"
    return True, f"已套用 CPU Job 硬上限 {pct}%"


def assign_child_to_job(pid: int) -> bool:
    """將子行程（如 FFmpeg）加入同一 Job。"""
    if _JOB_HANDLE is None:
        return False
    return _assign_pid_to_job(_JOB_HANDLE, pid)
