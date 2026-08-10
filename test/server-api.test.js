const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

// 用临时数据目录隔离画像；启动一个独立实例
process.env.RECOMMEND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "srv-"));
const { createServer } = require("../server.js");

let server, base;
test.before(async () => {
  server = createServer();
  await new Promise((res) => server.listen(0, res));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((res) => server.close(res)));

function post(url, body) {
  return fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /api/events 接受合法事件", async () => {
  const r = await post("/api/events", { events: [{ type: "like", name: "乱伦片A.mp4" }] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), { ok: true });
});

test("GET /api/recommend 返回推荐列表（含理由）", async () => {
  const r = await fetch(base + "/api/recommend");
  assert.strictEqual(r.status, 200);
  const data = await r.json();
  assert.ok(Array.isArray(data.list));
  for (const item of data.list) {
    assert.ok(typeof item.name === "string");
    assert.ok(typeof item.reason === "string");
    assert.ok(Number.isInteger(item.groupCount));
  }
});

test("POST /api/events 非法事件被忽略且不报错", async () => {
  const r = await post("/api/events", { events: [{ type: "hack", name: "../x" }, { name: "无类型" }] });
  assert.strictEqual(r.status, 200);
});
