// 局域网短视频流播放器 —— 静态资源服务
// 仅依赖 Node 内置模块，无任何第三方包
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "8080", 10);
const DISLIKE_MS = parseInt(process.env.DISLIKE_MS || "300000", 10);
const PROJECT_ROOT = __dirname;
const MEDIA_FOLDER = path.join(PROJECT_ROOT, "media");
const MAX_CHUNK = 4 * 1024 * 1024; // 单次范围响应上限 4MB
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

// 待删除队列：文件名 -> 定时器句柄
const pendingDeletes = new Map();

function mimeOf(ext) {
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

// 最小化的错误回复：只给状态码与一行正文
function replyPlain(res, statusCode, body) {
  res.writeHead(statusCode);
  res.end(body);
}

// 成功回复 JSON
function replyOk(res) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true }));
}

// 输出媒体目录下的文件名列表（隐藏文件与待删除文件除外）
function emitFileList(res) {
  try {
    const names = fs
      .readdirSync(MEDIA_FOLDER)
      .filter(
        (name) => !name.startsWith(".") && !pendingDeletes.has(name),
      );
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

// 处理不喜欢接口：schedule 安排延迟删除，cancel 撤销删除
async function handleDislike(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    replyPlain(res, 400, "Bad request");
    return;
  }
  const name = typeof body.name === "string" ? body.name : "";
  if (!name || path.basename(name) !== name) {
    replyPlain(res, 400, "Bad request");
    return;
  }
  const filePath = path.join(MEDIA_FOLDER, name);
  const action = body.action === "cancel" ? "cancel" : "schedule";

  if (action === "cancel") {
    const timer = pendingDeletes.get(name);
    if (timer) {
      clearTimeout(timer);
      pendingDeletes.delete(name);
    }
    replyOk(res);
    return;
  }

  // schedule：文件必须真实存在；已安排过则幂等返回
  if (!fs.existsSync(filePath)) {
    replyPlain(res, 404, "Not found");
    return;
  }
  if (pendingDeletes.has(name)) {
    replyOk(res);
    return;
  }
  const timer = setTimeout(() => {
    pendingDeletes.delete(name);
    fs.unlink(filePath, () => {});
  }, DISLIKE_MS);
  pendingDeletes.set(name, timer);
  replyOk(res);
}

// 解析 Range 头并做边界收窄：越界截断、起点修正、分片限长
function resolveRange(rawHeader, fileSize) {
  const [startText, endText] = rawHeader.replace(/bytes=/, "").split("-");
  let begin = parseInt(startText, 10) || 0;
  let finish = endText ? parseInt(endText, 10) : fileSize - 1;
  if (finish >= fileSize) finish = fileSize - 1;
  if (begin > finish) begin = finish;
  if (finish - begin + 1 > MAX_CHUNK) finish = begin + MAX_CHUNK - 1;
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

// 请求路由：先处理接口与目录列表，再走静态文件流程
async function routeRequest(req, res) {
  const decoded = decodeURIComponent(req.url.split("?")[0]);
  const requestPath = decoded === "/" ? "/index.html" : decoded;

  if (requestPath === "/api/dislike") {
    if (req.method !== "POST") {
      replyPlain(res, 404, "Not found");
      return;
    }
    await handleDislike(req, res);
    return;
  }

  if (requestPath === "/media" || requestPath === "/media/") {
    emitFileList(res);
    return;
  }

  const resolved = path.join(PROJECT_ROOT, requestPath);
  if (!resolved.startsWith(PROJECT_ROOT)) {
    replyPlain(res, 403, "Forbidden");
    return;
  }

  fs.stat(resolved, (err, info) => {
    if (err || !info.isFile()) {
      replyPlain(res, 404, "Not found");
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    deliver(
      res,
      resolved,
      info.size,
      mimeOf(ext),
      req.headers.range,
      RANGE_SUPPORTED.has(ext),
    );
  });
}

// 组装服务实例（供主进程与测试共用）
function createServer() {
  return http.createServer(routeRequest);
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = { createServer, PORT, DISLIKE_MS, pendingDeletes };
