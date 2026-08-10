const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

process.env.RECOMMEND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
const scan = require("../scan-metadata.js");

test("checkTools 存在时返回 true（本机已装 ffmpeg）", () => {
  assert.strictEqual(scan.checkTools(), true);
});

test("parseProbe 解析 ffprobe JSON 输出", () => {
  const out = JSON.stringify({
    format: { duration: "123.5" },
    streams: [
      { codec_type: "audio", duration: "123.5" },
      { codec_type: "video", width: 1920, height: 1080 },
    ],
  });
  const info = scan.parseProbe(out);
  assert.strictEqual(info.duration, 123.5);
  assert.strictEqual(info.width, 1920);
  assert.strictEqual(info.height, 1080);
});

test("parseProbe 无视频流或坏 JSON 返回 null", () => {
  assert.strictEqual(scan.parseProbe("not-json"), null);
  assert.strictEqual(scan.parseProbe(JSON.stringify({ format: { duration: "1" }, streams: [] })), null);
});
