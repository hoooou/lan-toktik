const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

process.env.RECOMMEND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
const rec = require("../recommend.js");

test("extractTags 按词表匹配文件名", () => {
  const tags = rec.extractTags("乱伦大神 新婚骚弟媳 白丝 口爆 _ 51吃瓜网.mp4");
  assert.ok(tags.includes("乱伦"));
  assert.ok(tags.includes("白丝"));
  assert.ok(tags.includes("口爆"));
});

test("extractTags 无词命中返回空数组", () => {
  assert.deepStrictEqual(rec.extractTags("普通生活记录.mp4"), []);
});

test("groupKey 剥离来源与日期后缀", () => {
  const a = rec.groupKey("乱伦大神 X _ 51吃瓜网-20260808-iwhuoh8w3o.mp4");
  const b = rec.groupKey("乱伦大神 X _ 51吃瓜网.mp4");
  assert.strictEqual(a, b);
  assert.ok(a.includes("乱伦大神 X"));
  assert.strictEqual(
    rec.groupKey("公公搞大儿媳肚子 _ 51吃瓜网-20260808-v8tlchfhuc.mp4"),
    rec.groupKey("公公搞大儿媳肚子 _ 51吃瓜网.mp4"),
  );
});

test("groupKey 处理 91视频 来源后缀", () => {
  const a = rec.groupKey("超高颜值网红美女 _ 91视频_91自拍_国产自拍.mp4");
  assert.ok(!a.includes("91视频"));
  assert.ok(a.includes("超高颜值网红美女"));
});

test("loadProfile 缺文件返回空画像", () => {
  const p = rec.loadProfile();
  assert.deepStrictEqual(p.tagWeights, {});
  assert.deepStrictEqual(p.videoStats, {});
});

test("applyEvents 权重表逐条生效", () => {
  rec.applyEvents([
    { type: "like", name: "乱伦片A.mp4" },
    { type: "finish", name: "乱伦片A.mp4" },
    { type: "skip", name: "白丝片B.mp4" },
    { type: "speedup", name: "乱伦片A.mp4" },
    { type: "seek_back", name: "乱伦片A.mp4" },
    { type: "delete", name: "白丝片B.mp4" },
    { type: "unlike", name: "乱伦片A.mp4" },
  ]);
  const p = rec.loadProfile();
  // 乱伦: like+3 finish+2 speedup-0.5 seek_back+1 unlike-3 = +2.5
  assert.strictEqual(p.tagWeights["乱伦"], 2.5);
  // 白丝: skip-1 delete-3 = -4
  assert.strictEqual(p.tagWeights["白丝"], -4);
});

test("applyEvents watch 达30% 才记 +0.5，且只记一次", () => {
  rec.applyEvents([{ type: "watch", name: "巨乳片C.mp4", t: 10 }], { "巨乳片C.mp4": { duration: 100 } });
  let p = rec.loadProfile();
  assert.strictEqual(p.tagWeights["巨乳"], undefined); // 10% < 30%
  rec.applyEvents([{ type: "watch", name: "巨乳片C.mp4", t: 40 }], { "巨乳片C.mp4": { duration: 100 } });
  p = rec.loadProfile();
  assert.strictEqual(p.tagWeights["巨乳"], 0.5);
  rec.applyEvents([{ type: "watch", name: "巨乳片C.mp4", t: 90 }], { "巨乳片C.mp4": { duration: 100 } });
  p = rec.loadProfile();
  // 90% 视作 finish 再记 +2：0.5(30%一次) + 2(finish一次) = 2.5；finish 同样不重复加
  assert.strictEqual(p.tagWeights["巨乳"], 2.5);
});

test("applyEvents 未知类型与非法名被忽略", () => {
  const before = rec.loadProfile();
  rec.applyEvents([{ type: "hack", name: "x.mp4" }, { type: "like", name: "../x.mp4" }]);
  const after = rec.loadProfile();
  assert.deepStrictEqual(after.tagWeights, before.tagWeights);
});
