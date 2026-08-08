const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8080;
const MEDIA_DIR = path.join(__dirname, "media");
const MIME = {
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

const RANGE_EXTS = new Set([
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

http
  .createServer((req, res) => {
    let url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/") url = "/index.html";

    // 列出媒体目录为JSON
    if (url === "/media/" || url === "/media") {
      try {
        const files = fs
          .readdirSync(MEDIA_DIR)
          .filter((f) => !f.startsWith("."));
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(files));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      }
      return;
    }

    const filePath = path.join(__dirname, url);
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const mime = MIME[ext] || "application/octet-stream";
      const hasRange = RANGE_EXTS.has(ext);
      const totalSize = stat.size;

      // 视频音频始终支持范围请求
      if (req.headers.range && hasRange) {
        const range = req.headers.range.replace(/bytes=/, "");
        const parts = range.split("-");
        let start = parseInt(parts[0], 10) || 0;
        let end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

        // 限制结束位置
        if (end >= totalSize) end = totalSize - 1;
        if (start > end) start = end;
        // 限制分片为4MB以确保稳定性
        if (end - start > 4 * 1024 * 1024) end = start + 4 * 1024 * 1024 - 1;

        const chunkSize = end - start + 1;

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${totalSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": mime,
          "Cache-Control": "no-cache",
        });

        fs.createReadStream(filePath, { start, end })
          .on("error", () => {
            try {
              res.end();
            } catch {}
          })
          .pipe(res);
      } else {
        // 完整响应
        res.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": totalSize,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-cache",
        });
        fs.createReadStream(filePath)
          .on("error", () => {
            try {
              res.end();
            } catch {}
          })
          .pipe(res);
      }
    });
  })
  .listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
