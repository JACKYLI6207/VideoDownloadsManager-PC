#!/usr/bin/env node
/**
 * 驗證導入片段路徑解析邏輯（不依賴 Chrome）。
 * 執行：node scripts/verify_import_segment_path.js
 */
"use strict";

const VDM = {
  sanitizeFilename: (s) => String(s || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim(),
  normalizeOptionalSubPath: (sub) => {
    const parts = String(sub || "")
      .replace(/\\/g, "/")
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean);
    return parts.join("/");
  },
  downloadSubfolder: "default-sub",
  buildTaskSegmentDirWithSub(fileName, subfolder) {
    const base = String(fileName || "").replace(/\.mp4$/i, "");
    const folder = this.sanitizeFilename(base) || "VIDEO";
    const sub = this.normalizeOptionalSubPath(subfolder);
    return sub ? `${sub}/${folder}` : folder;
  },
  buildTaskSegmentDir(fileName) {
    return this.buildTaskSegmentDirWithSub(fileName, this.downloadSubfolder);
  },
  resolveTaskSegmentDir(task) {
    if (!task) return this.buildTaskSegmentDir("");
    if (task.importFsaKey) {
      return this.buildTaskSegmentDirWithSub(task.fileName, "");
    }
    if (task.segmentSubfolder !== undefined && task.segmentSubfolder !== null) {
      return this.buildTaskSegmentDirWithSub(task.fileName, task.segmentSubfolder);
    }
    if (task.segmentDir) return String(task.segmentDir);
    return this.buildTaskSegmentDir(task.fileName);
  },
};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("verify_import_segment_path.js");

test("預設路徑含 downloadSubfolder", () => {
  const dir = VDM.resolveTaskSegmentDir({ fileName: "My Video.mp4" });
  assert(dir === "default-sub/My Video", `got ${dir}`);
});

test("手填子路徑（無 importFsaKey）", () => {
  const dir = VDM.resolveTaskSegmentDir({
    fileName: "clip.mp4",
    segmentSubfolder: "batch-A",
  });
  assert(dir === "batch-A/clip", `got ${dir}`);
});

test("選資料夾導入（importFsaKey）→ 僅任務名，不含全域子路徑", () => {
  const dir = VDM.resolveTaskSegmentDir({
    fileName: "episode.mp4",
    importFsaKey: "import-abc",
    segmentSubfolder: "should-be-ignored",
    segmentDir: "old/wrong/path",
  });
  assert(dir === "episode", `got ${dir}`);
});

test("importTasksPayload 模擬：有 importFsaKey 時 subfolder 為空", () => {
  const importFsaKey = "import-xyz";
  const subfolder = importFsaKey ? "" : "custom";
  const segmentDir = VDM.buildTaskSegmentDirWithSub("foo.mp4", subfolder);
  assert(segmentDir === "foo", `got ${segmentDir}`);
});

test("importTasksPayload 模擬：手填 custom 子路徑", () => {
  const importFsaKey = "";
  const customSubfolder = "my/import/batch";
  const subfolder = importFsaKey ? "" : customSubfolder;
  const segmentDir = VDM.buildTaskSegmentDirWithSub("foo.mp4", subfolder);
  assert(segmentDir === "my/import/batch/foo", `got ${segmentDir}`);
});

if (!process.exitCode) {
  console.log("\nAll checks passed.");
}
