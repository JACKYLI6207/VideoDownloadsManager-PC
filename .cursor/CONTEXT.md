# 新對話必讀 — Video Downloads Manager PC（EXE）

> **最後更新**：2026-06-12  
> **內建擴充版本**：1.2.12（`extension-src/manifest-pc.json`）  
> **EXE 圖示**：`logo.ico`  
> **產物大小**：約 78 MB（onefile，含 FFmpeg）

---

## 專案路徑（唯一、強制）

**所有 PC 版開發、修改、備份、建置，一律在此目錄：**

```
C:\Users\Jacky-PC-New\Desktop\Project\VIideo-Downloads-Manager-Chrome-Windows\VIideo-Downloads-Manager-Windows
```

本專案**自包含**，不依賴 `New-VIideo-Downloads-Manager` 或其他資料夾。

| 子目錄 / 檔案 | 用途 |
|---------------|------|
| `extension-src/` | VDM PC 擴充原始碼（`manifest-pc.json`、`panel-pc.*`） |
| `vdm_pc/` | Python 主程式 |
| `scripts/` | 建置、備份腳本 |
| `vdm-pc.spec` | PyInstaller onefile 設定 |
| `VideoDownloadsManagerPC.exe` | 建置產物（單一檔案） |

建置暫存（gitignore）：`extension/`、`build/`、`.venv/`

---

## 架構概覽

```
EXE 啟動（onefile → 解壓至 %TEMP%\_MEI*\）
  ├─ bridge_server (127.0.0.1:18429)  ← 擴充 POST 任務
  ├─ 下載引擎（進行中 / 已完成）
  └─ 瀏覽器分頁
        └─ 系統 Google Chrome + BiDi 載入 VDM 擴充
              ├─ 未安裝 Chrome → chrome_install.py 自動下載安裝
              ├─ Chromedriver 依偵錯埠 Chrome 版本自動對齊
              ├─ 嗅探影片（content/sniffer.js）
              ├─ 「添加至可下載清單」→ POST 到 bridge
              └─ 「下載封面」→ 面板直接用 chrome.downloads（不送 PC）
```

| 職責 | 位置 |
|------|------|
| 影片下載 / 合併 / 持久化 | `vdm_pc/download/` |
| 嗅探 + 推送任務 | 打包擴充（執行時 `sys._MEIPASS/vdm-extension/`） |
| 可下載清單 UI | EXE「瀏覽器」分頁左側（`QTableWidget`：影片名稱 / 解析度；欄位可排序；名稱為可點擊複製按鈕） |

---

## 建置 EXE

改 `vdm_pc/` 或 `extension-src/` 後**必須重新建置**。

```powershell
cd C:\Users\Jacky-PC-New\Desktop\Project\VIideo-Downloads-Manager-Chrome-Windows\VIideo-Downloads-Manager-Windows
powershell -ExecutionPolicy Bypass -File build_exe.ps1
```

快速建置（略過 pip）：`build_exe_quick.ps1`

流程：`prepare_vdm_extension.ps1`（`extension-src/` → `extension/<id>/`）→ PyInstaller **onefile**

產出：專案根目錄 **`VideoDownloadsManagerPC.exe`**（單一檔案）

| 打包內容 | 說明 |
|----------|------|
| VDM 擴充 | `vdm-extension/` |
| FFmpeg | `imageio_ffmpeg`（HLS 合併，約 80MB，體積主因） |
| PyQt6 | 僅 QtCore / QtGui / QtWidgets（已精簡，不用 `collect_all`） |
| Selenium | 僅 Chrome BiDi 載入擴充所需模組 |

建置前**關閉執行中 EXE**。

改擴充後須 bump `extension-src/manifest-pc.json` version。

---

## 可攜式與依賴

| 項目 | 說明 |
|------|------|
| 發佈 | 只需複製 `VideoDownloadsManagerPC.exe` |
| Python | 不需要 |
| Google Chrome | 未安裝時，首次「啟動瀏覽器」自動下載安裝（需網路） |
| Chromedriver | 首次 BiDi 載入擴充時 Selenium 可能下載（需網路） |
| FFmpeg | 已內建於 EXE |

---

## 備份（Git）

```powershell
cd C:\Users\Jacky-PC-New\Desktop\Project\VIideo-Downloads-Manager-Chrome-Windows\VIideo-Downloads-Manager-Windows
powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
```

---

## 執行與資料路徑

| 項目 | 路徑 |
|------|------|
| 設定 | `%APPDATA%\VideoDownloadsManager-PC\settings.json` |
| 片段暫存 | `%LOCALAPPDATA%\VideoDownloadsManager-PC\vdm-cache\{video.id}\` |
| 進行中任務 | `%APPDATA%\VideoDownloadsManager-PC\active_tasks.json` |
| 瀏覽器設定檔 | `%LOCALAPPDATA%\VideoDownloadsManager-PC\browser-profile\` |
| 使用者擴充 | `%LOCALAPPDATA%\VideoDownloadsManager-PC\extensions\` |
| Chrome 安裝快取 | `%LOCALAPPDATA%\VideoDownloadsManager-PC\chrome-setup\` |
| 預設下載 | `%USERPROFILE%\Downloads\VideoDownloadsManager` |

---

## UI 分頁

| 分頁 | 說明 |
|------|------|
| 瀏覽器 | 啟動 Chrome + VDM 擴充；左側「可下載清單」（排序、點名稱複製） |
| 進行中 | HLS 雙進度條；暫停/繼續/從頭/中斷；任務匯入 |
| 已完成 | 歷史完成列表 |
| 日誌 | 錯誤與事件 |
| 設定 | 並發、連線、路徑、第三方擴充網址 |

---

## 擴充面板（PC 精簡版）

| 按鈕 | 行為 |
|------|------|
| 添加至可下載清單 | POST → `127.0.0.1:18429/push-tasks` |
| 群組添加至可下載清單 | 面板依群組各分頁快取取最高畫質 → `START_GROUP_DOWNLOADS`（`items` + `resniff: false`）→ POST；**PC 模式不重新嗅探、不切換分頁** |
| 下載封面 / 群組下載封面 | `chrome.downloads` 存 `.jpg`（不進 PC 清單） |

擴充 ID：`anokolhjgbidjccbgmahcgdagmmdoddi`（manifest `key` 計算）

---

## 設定（`settings.json`）

| 鍵 | 預設 | 說明 |
|----|------|------|
| `maxConcurrentTasks` | 2 | 同時執行任務數 |
| `maxConnections` | 3 | 單任務 HLS 片段並行 |
| 全局片段連線 | — | `min(108, 任務數×連線數)` |
| `downloadFolder` | Downloads/VideoDownloadsManager | 下載根目錄 |
| `browserExtensionUrls` | （空） | 每行 CRX URL 或本機路徑 |

---

## 關鍵模組

| 路徑 | 職責 |
|------|------|
| `main.py` | 入口、視窗圖示、bridge 啟動 |
| `vdm_pc/app.py` | 主視窗、分頁 |
| `vdm_pc/bridge_server.py` | HTTP 18429，接收擴充任務 |
| `vdm_pc/browser/driver.py` | 啟動 Chrome、BiDi 載入 VDM |
| `vdm_pc/browser/chrome_install.py` | 未安裝時自動下載安裝 Chrome |
| `vdm_pc/browser/chrome_paths.py` | Chrome 路徑解析 |
| `vdm_pc/browser/extension_install.py` | 設定檔同步、BiDi 安裝、Chromedriver 版本對齊 |
| `vdm_pc/browser/panel.py` | 可下載清單（雙欄表格、排序、名稱複製按鈕）、瀏覽器日誌 |
| `vdm_pc/ui/styles.py` | 全域樣式；`copyNameBtn` 名稱按鈕樣式 |
| `vdm_pc/models.py` | `guess_quality()`：從 m3u8 URL 解析 `1080p` / `1280x720` 等 |
| `vdm_pc/extension_bundle.py` | 打包擴充路徑（`sys._MEIPASS`） |
| `vdm_pc/download/engine.py` | 隊列、HLS、暫停/繼續 |
| `scripts/prepare_vdm_extension.ps1` | 建置前 `extension-src/` → `extension/<id>/` |
| `vdm-pc.spec` | PyInstaller onefile；精簡 PyQt6/Selenium |

---

## 注意事項

- **禁止** `--load-extension` 載入 VDM（新版 Chrome 會導致擴充空白）；改用 **BiDi**
- **禁止**內建 Chrome for Testing（已移除）；只用系統 Google Chrome
- `prepare_vdm_extension.ps1` 腳本註解須 **ASCII**，避免 PowerShell 5.1 編碼誤解析 `$ExtId`
- 封面下載在 `panel-pc.js` 直接呼叫 `chrome.downloads`，不走 `START_DOWNLOADS`
- **不支援** YouTube
- 擴充更新後須**關閉並從 EXE 重啟瀏覽器**；面板與 Service Worker 版本不一致會出現「未知指令」（例如曾短暫使用 `PUSH_PC_DOWNLOADS`）
- `extension_install.py`：manifest 版本變更時強制同步擴充至 Chrome 設定檔
