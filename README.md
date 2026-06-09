# Video Downloads Manager PC

Chrome 擴充下載核心的獨立 Windows 桌面版。瀏覽器參考 [m3u8-video-sniffer](https://github.com/royswift2007/m3u8-video-sniffer)。

## 功能

| 分頁 | 說明 |
|------|------|
| **瀏覽器** | Playwright + Chrome，嗅探 m3u8/mp4，Cookie 持久化 |
| **進行中** | 雙進度條（下載/合併）、批量操作、導入/導出 JSON |
| **已完成** | 歷史紀錄、開啟檔案 |
| **日誌** | 事件紀錄 |
| **設定** | 並行數、子路徑、暫存目錄 |

### 下載引擎（對齊擴充）

- HLS 多執行緒片段下載 + **邊下邊合併**
- **FFmpeg** 封裝為標準 MP4
- 大檔 HTTP **Range 並行**下載
- 403/401/429 自動**暫停**（可繼續）
- 任務**持久化**（重開程式還原為暫停）
- 相容擴充 `vdm-active-tasks` JSON 導入

## 開發執行

```powershell
cd C:\Users\Jacky-PC-New\Desktop\Project\New-VIideo-Downloads-Manager-PC
.\run.bat
```

## 打包 EXE

```powershell
powershell -ExecutionPolicy Bypass -File build_exe.ps1
```

輸出：`dist\VideoDownloadsManagerPC\VideoDownloadsManagerPC.exe`

> 瀏覽器功能需本機已安裝 **Google Chrome**。下載/合併無需額外安裝 FFmpeg（已內建）。

## 與擴充協作

1. 擴充 **進行中** → **導出**
2. PC 版 **導入** → 勾選 → **繼續**（重頭下載）
