// 媒体元数据扫描：ffprobe 读时长/分辨率，ffmpeg 抽封面帧（硬性依赖，缺失即报错退出）
const { execFileSync, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const MEDIA_FOLDER = path.join(__dirname, "media");
const DATA_DIR = process.env.RECOMMEND_DATA_DIR || path.join(__dirname, "data");
const META_FILE = path.join(DATA_DIR, "media-meta.json");
const COVER_DIR = path.join(DATA_DIR, "covers");

// 硬性依赖检测：ffprobe/ffmpeg 任一缺失 → 打印错误并退出（不做静默降级）
function checkTools() {
  for (const tool of ["ffprobe", "ffmpeg"]) {
    try {
      execFileSync(tool, ["-version"], { stdio: "ignore" });
    } catch {
      console.error(`[scan] 缺少系统工具 ${tool}：请先安装 ffmpeg（含 ffprobe）`);
      process.exit(1);
    }
  }
  return true;
}

// 解析 ffprobe -print_format json 输出；无视频流或解析失败返回 null
function parseProbe(stdout) {
  try {
    const j = JSON.parse(stdout);
    const dur = Number(j.format && j.format.duration);
    const v = (j.streams || []).find((s) => s.codec_type === "video");
    if (!v || !(dur > 0) || !v.width || !v.height) return null;
    return { duration: dur, width: v.width, height: v.height };
  } catch {
    return null;
  }
}

// ffprobe 探测单个文件
function probeFile(filePath) {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : parseProbe(stdout)),
    );
  });
}

// ffmpeg 抽帧：视频 10% 位置，宽 320 的 JPG
function extractCover(filePath, outPath, duration) {
  const pos = Math.min(duration * 0.1, 60);
  return new Promise((resolve) => {
    execFile(
      "ffmpeg",
      ["-y", "-ss", String(pos), "-i", filePath, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", outPath],
      { maxBuffer: 1024 * 1024 },
      (err) => resolve(!err),
    );
  });
}

function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveMeta(meta) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = META_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, META_FILE);
}

// 增量扫描：media/ 下新增或元数据缺失的文件才处理；封面失败不影响元数据入库
async function runScan() {
  checkTools();
  fs.mkdirSync(COVER_DIR, { recursive: true });
  const meta = loadMeta();
  let scanned = 0, skipped = 0, failed = 0;
  const names = fs.readdirSync(MEDIA_FOLDER).filter((n) => !n.startsWith("."));
  for (const name of names) {
    const filePath = path.join(MEDIA_FOLDER, name);
    let st;
    try { st = fs.statSync(filePath); } catch { failed += 1; continue; }
    if (!st.isFile()) continue;
    if (meta[name]) { skipped += 1; continue; } // 增量：已有元数据则跳过
    const info = await probeFile(filePath);
    if (!info) { failed += 1; continue; }
    const coverPath = path.join(COVER_DIR, name + ".jpg");
    const coverOk = await extractCover(filePath, coverPath, info.duration);
    meta[name] = { ...info, cover: coverOk };
    scanned += 1;
    if (scanned % 20 === 0) saveMeta(meta); // 分批落盘，中断不丢已扫部分
  }
  saveMeta(meta);
  return { scanned, skipped, failed };
}

// 独立运行时：校验工具 → 扫描 → 打印摘要
if (require.main === module) {
  runScan()
    .then((r) => console.log(`[scan] 完成：新增 ${r.scanned}，跳过 ${r.skipped}，失败 ${r.failed}`))
    .catch((e) => { console.error("[scan] 失败：", e.message); process.exit(1); });
}

module.exports = { MEDIA_FOLDER, DATA_DIR, COVER_DIR, checkTools, parseProbe, probeFile, extractCover, runScan };
