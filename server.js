// 局域网短视频流播放器 —— 静态资源服务
// 仅依赖 Node 内置模块，无任何第三方包
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const rec = require("./recommend");
// MEDIA_FOLDER 已在本文件定义（值相同），此处只取 DATA_DIR / COVER_DIR
const { DATA_DIR, COVER_DIR } = require("./scan-metadata");

const PORT = parseInt(process.env.PORT || "8080", 10);
const PROJECT_ROOT = __dirname;
const MEDIA_FOLDER = path.join(PROJECT_ROOT, "media");
const TRASH_DIR = path.join(PROJECT_ROOT, ".trash");
const MAX_BODY = 64 * 1024; // 请求体大小上限

// 各文件类型的 Content-Type 对照
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".wma": "audio/wma",
};

// 只有音视频允许分段传输
const RANGE_SUPPORTED = new Set([
  ".mp4",
  ".webm",
  ".mov",
  ".mp3",
  ".wav",
  ".flac",
  ".aac",
  ".m4a",
  ".wma",
  ".ogg",
]);

function mimeOf(ext) {
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

// 名字校验：仅允许普通文件名，杜绝路径穿越
function isPlainName(name) {
  return typeof name === "string" && name.length > 0 && path.basename(name) === name;
}

// 最小化的错误回复：只给状态码与一行正文
function replyPlain(res, statusCode, body) {
  res.writeHead(statusCode);
  res.end(body);
}

// JSON 回复
function replyJson(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function replyOk(res) {
  replyJson(res, { ok: true });
}

// 确保回收站目录存在（懒创建）
function ensureTrash() {
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  return TRASH_DIR;
}

// 读取请求体（受大小限制）
function readBody(req) {
  return new Promise((resolve) => {
    const pieces = [];
    let total = 0;
    req.on("data", (buf) => {
      total += buf.length;
      if (total > MAX_BODY) {
        req.destroy();
        return;
      }
      pieces.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(pieces).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

// 输出媒体目录下的文件名列表（隐藏文件除外）
function emitFileList(res) {
  try {
    const names = fs
      .readdirSync(MEDIA_FOLDER)
      .filter((name) => !name.startsWith("."));
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(names));
  } catch {
    // 目录缺失或不可读时按空列表处理
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("[]");
  }
}

// 读取媒体元数据缓存（缺失时返回空对象）
function readMediaMeta() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, "media-meta.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

// 输出回收站文件名列表（隐藏文件除外）
function emitTrashList(res) {
  try {
    const names = fs
      .readdirSync(ensureTrash())
      .filter((name) => !name.startsWith("."));
    replyJson(res, names);
  } catch {
    replyJson(res, []);
  }
}

// 删除接口：media/name 移入回收站
async function handleDelete(req, res) {
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    replyPlain(res, 400, "Bad request");
    return;
  }
  const name = payload.name;
  if (!isPlainName(name)) {
    replyPlain(res, 400, "Bad request");
    return;
  }
  ensureTrash();
  const src = path.join(MEDIA_FOLDER, name);
  const dst = path.join(TRASH_DIR, name);
  if (!fs.existsSync(src)) {
    replyPlain(res, 404, "Not found");
    return;
  }
  if (fs.existsSync(dst)) {
    replyPlain(res, 409, "Conflict");
    return;
  }
  try {
    fs.renameSync(src, dst);
  } catch {
    replyPlain(res, 500, "Server error");
    return;
  }
  replyOk(res);
}

// 回收站操作：restore 还原、purge 清空
async function handleTrashPost(req, res) {
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    replyPlain(res, 400, "Bad request");
    return;
  }

  if (payload.action === "restore") {
    const name = payload.name;
    if (!isPlainName(name)) {
      replyPlain(res, 400, "Bad request");
      return;
    }
    ensureTrash();
    const src = path.join(TRASH_DIR, name);
    const dst = path.join(MEDIA_FOLDER, name);
    if (!fs.existsSync(src)) {
      replyPlain(res, 404, "Not found");
      return;
    }
    if (fs.existsSync(dst)) {
      replyPlain(res, 409, "Conflict");
      return;
    }
    try {
      fs.renameSync(src, dst);
    } catch {
      replyPlain(res, 500, "Server error");
      return;
    }
    replyOk(res);
    return;
  }

  if (payload.action === "purge") {
    let deleted = 0;
    for (const name of fs.readdirSync(ensureTrash())) {
      if (name.startsWith(".")) continue;
      try {
        fs.unlinkSync(path.join(TRASH_DIR, name));
        deleted += 1;
      } catch {
        // 单个失败忽略，继续清空其余
      }
    }
    replyJson(res, { ok: true, deleted });
    return;
  }

  replyPlain(res, 400, "Bad request");
}

// 解析 Range 头并做边界收窄：越界截断、起点修正
// 按请求的完整范围响应，避免分片过小导致串行往返降低吞吐
function resolveRange(rawHeader, fileSize) {
  const [startText, endText] = rawHeader.replace(/bytes=/, "").split("-");
  let begin = parseInt(startText, 10) || 0;
  let finish = endText ? parseInt(endText, 10) : fileSize - 1;
  if (finish >= fileSize) finish = fileSize - 1;
  if (begin > finish) begin = finish;
  return { begin, finish };
}

// 以流式方式吐文件内容；客户端中断时静默收尾
function pump(res, filePath, begin, finish) {
  fs.createReadStream(filePath, { start: begin, end: finish })
    .on("error", () => {
      try {
        res.end();
      } catch {}
    })
    .pipe(res);
}

// 按 Range 与否分发两种响应形态
function deliver(res, filePath, size, mime, rangeHeader, rangeEnabled) {
  if (rangeHeader && rangeEnabled) {
    const { begin, finish } = resolveRange(rangeHeader, size);
    res.writeHead(206, {
      "Content-Range": `bytes ${begin}-${finish}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": finish - begin + 1,
      "Content-Type": mime,
      "Cache-Control": "no-cache",
    });
    pump(res, filePath, begin, finish);
    return;
  }
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  });
  pump(res, filePath, 0, size - 1);
}

// 从指定目录按文件名提供文件（MIME/Range 与媒体一致）
function serveFromDir(req, res, folder, name) {
  const filePath = path.join(folder, name);
  if (!filePath.startsWith(folder)) {
    replyPlain(res, 403, "Forbidden");
    return;
  }
  fs.stat(filePath, (err, info) => {
    if (err || !info.isFile()) {
      replyPlain(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    deliver(
      res,
      filePath,
      info.size,
      mimeOf(ext),
      req.headers.range,
      RANGE_SUPPORTED.has(ext),
    );
  });
}

// 请求路由：先处理接口与目录列表，再走静态文件流程
async function routeRequest(req, res) {
  const decoded = decodeURIComponent(req.url.split("?")[0]);
  const requestPath = decoded === "/" ? "/index.html" : decoded;

  // 行为事件上报：批量更新画像
  if (requestPath === "/api/events") {
    if (req.method !== "POST") {
      replyPlain(res, 404, "Not found");
      return;
    }
    const raw = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(raw || "{}");
    } catch {
      replyPlain(res, 400, "Bad request");
      return;
    }
    const events = Array.isArray(payload.events) ? payload.events : [];
    // 事件校验：type 白名单 + 文件名合法性
    const EVENT_TYPES = new Set([
      "like", "unlike", "fav", "unfav", "delete",
      "watch", "finish", "skip", "speedup", "seek_fwd", "seek_back",
    ]);
    const valid = events.filter(
      (e) => e && EVENT_TYPES.has(e.type) && isPlainName(e.name),
    );
    rec.applyEvents(valid, readMediaMeta());
    replyOk(res);
    return;
  }

  // 推荐列表：排除回收站，返回排序 + 理由
  if (requestPath === "/api/recommend") {
    if (req.method !== "GET") {
      replyPlain(res, 404, "Not found");
      return;
    }
    const mediaNames = fs
      .readdirSync(MEDIA_FOLDER)
      .filter((n) => !n.startsWith("."));
    const trashNames = fs
      .readdirSync(ensureTrash())
      .filter((n) => !n.startsWith("."));
    const list = rec.buildRecommend({
      mediaNames,
      trashNames,
      meta: readMediaMeta(),
    });
    replyJson(res, { list });
    return;
  }

  // 封面图静态服务
  if (requestPath.startsWith("/data/covers/")) {
    const name = requestPath.slice("/data/covers/".length);
    if (!isPlainName(name)) {
      replyPlain(res, 404, "Not found");
      return;
    }
    serveFromDir(req, res, COVER_DIR, name);
    return;
  }

  if (requestPath === "/api/delete") {
    if (req.method !== "POST") {
      replyPlain(res, 404, "Not found");
      return;
    }
    await handleDelete(req, res);
    return;
  }

  if (requestPath === "/api/trash") {
    if (req.method === "GET") {
      emitTrashList(res);
      return;
    }
    if (req.method === "POST") {
      await handleTrashPost(req, res);
      return;
    }
    replyPlain(res, 404, "Not found");
    return;
  }

  // 回收站内文件的播放路径
  if (requestPath.startsWith("/trash/")) {
    const name = requestPath.slice("/trash/".length);
    if (!isPlainName(name)) {
      replyPlain(res, 404, "Not found");
      return;
    }
    serveFromDir(req, res, TRASH_DIR, name);
    return;
  }

  // 禁止直接访问回收站目录本身，防绕过
  if (requestPath.startsWith("/.trash")) {
    replyPlain(res, 404, "Not found");
    return;
  }

  if (requestPath === "/media" || requestPath === "/media/") {
    emitFileList(res);
    return;
  }

  serveFromDir(req, res, PROJECT_ROOT, requestPath);
}

// 组装服务实例（供主进程与测试共用）
function createServer() {
  return http.createServer(routeRequest);
}

if (require.main === module) {
  // 启动后台元数据扫描（子进程方式，不阻塞主服务；退出码非 0 时打印醒目错误）
  const scanProc = spawn(process.execPath, [path.join(__dirname, "scan-metadata.js")], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  scanProc.on("exit", (code) => {
    if (code !== 0) {
      console.error(`[scan] 元数据扫描失败（退出码 ${code}）：请确认已安装 ffmpeg/ffprobe`);
    }
  });

  createServer().listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = { createServer, PORT, TRASH_DIR };
