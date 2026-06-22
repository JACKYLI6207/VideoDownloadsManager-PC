# Video Downloads Manager（Chrome / Edge 擴充功能）

偵測網頁影片、支援 MP4 直連與 HLS 下載合併，完成後透過**瀏覽器原生下載**存入下載資料夾（無獨立「已完成」頁面）。

## 功能

- **可下載**：播放影片後自動嗅探 m3u8 / mp4 等 URL，側邊欄選擇解析度後下載
- **進行中**：顯示進度、速度，可暫停 / 繼續 / 中斷
- **完成後**：合併為 MP4 並觸發 `chrome.downloads`，檔案出現在瀏覽器下載目錄

建議搭配 [AdGuard 廣告封鎖器](https://chromewebstore.google.com/detail/adguard-adblocker/bgnkhhnnamicmpeenaelnjfhikgbkllg?hl=zh-TW) 使用。

## 安裝（開發者模式）

> **手動安裝請點「載入未封裝項目」**，然後選本專案的 `extension-chrome-src` 資料夾。

### Chrome

1. 網址列輸入 `chrome://extensions/` 後 Enter
2. 右上角開啟「**開發人員模式**」
3. 點「**載入未封裝項目**」（不是「封裝擴充功能」）
4. 選擇本專案根目錄下的 `extension-chrome-src` 資料夾
5. 列表出現 **Video Downloads Manager** 即成功

### Edge

1. 開啟 `edge://extensions/`
2. 開啟「開發人員模式」
3. 點「載入未封裝項目」
4. 選擇本資料夾

## 使用方式

1. 瀏覽並**播放**影片
2. 點工具列擴充圖示（或 badge 數字）開啟**側邊欄**
3. 「可下載」分頁勾選項目 → **下載選取項目**
4. 「進行中」分頁查看進度
5. 完成後在瀏覽器下載記錄 / 下載資料夾取得 MP4

## 專案結構

```
manifest.json           # MV3 擴充清單
background/
  service_worker.js     # 嗅探、任務隊列、下載
content/
  sniffer.js            # 頁面內 fetch/XHR 補捉
lib/
  detector.js           # URL 判斷（移植自 EXE）
  videoStore.js         # 每分頁影片池
  m3u8.js               # M3U8 解析
  downloadEngine.js     # 下載與合併
sidepanel/
  panel.html/js/css     # 可下載 + 進行中 UI
```

## HLS 合併說明

HLS 片段下載後以 MPEG-TS 串接並存為 `.mp4`。多數 H.264/AAC 串流可直接播放；若無法播放，可改用 VLC 開啟或後續版本加入 ffmpeg.wasm。

## 限制

- 不支援 YouTube（與 EXE 相同）
- 部分網站 CDN 需登入 Cookie，可能下載失敗
- Service Worker 在極長任務時可能休眠；已用 alarm 盡量保持活躍
