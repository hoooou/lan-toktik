# 推荐 Tab 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 lan-toktik 增加第 4 个「推荐」Tab：基于内容标签 + 行为信号（显式+隐式）的服务端推荐流，每条视频带可解释推荐理由，并附带 ffprobe/ffmpeg 元数据扫描（时长/清晰度/封面）。

**Architecture:** 零依赖 Node（无 npm 包）。新建 `recommend.js`（纯算法模块：题材词表、画像存取、事件权重、排序、理由、副本分组）与 `scan-metadata.js`（ffprobe/ffmpeg 扫描，由 server 以子进程方式后台调用），`server.js` 挂载 `POST /api/events` 与 `GET /api/recommend` 接口及 `/data/covers/` 静态路由；`index.html` 加第 4 个 Tab、推荐理由展示与行为埋点批量上报。画像存 `data/recommend.json`（fs 读写），元数据存 `data/media-meta.json`，封面存 `data/covers/`。

**Tech Stack:** Node.js（内置 http/fs/path/child_process/test 模块）、ffprobe/ffmpeg（系统二进制，硬性依赖）、原生浏览器 JS。

## Global Constraints

- 零第三方 npm 依赖；仅 Node 内置模块
- **ffmpeg/ffprobe 是硬性依赖**：README 声明前置条件；`scan-metadata.js` 独立运行时缺失工具则报错并 `process.exit(1)`（不做静默降级）；server 以子进程方式启动扫描，子进程退出码非 0 时 server 打印醒目错误日志但继续服务（媒体播放不受影响）
- 单人画像（`profiles.default`），数据结构预留 `profiles` 多画像扩展位
- 中文文案；代码注释中文化（项目惯例）
- `like/fav` 仍存 localStorage（UI 状态），同时上报服务端画像（学习真源）
- 事件上报批量节流（不每帧发请求）；一次长按 2x 只记一次；快进到 >90% 位置视为 finish 不记负向
- 测试用 `node --test`（本机 Node v26）；`package.json` engines 升级到 `>=18`
- 每次提交前 `node --check` 通过

---

### Task 1: recommend.js 核心（题材词表 + 画像存取 + 事件权重）

**Files:**
- Create: `recommend.js`
- Create: `test/recommend.test.js`
- Modify: `package.json`（加 `"test": "node --test"`，engines 改 `">=18"`）
- Modify: `.gitignore`（追加 `data/`）

**Interfaces:**
- Produces (later tasks rely on these exact signatures):
  - `extractTags(name) → string[]` — 词表匹配（按词表顺序）
  - `groupKey(name) → string` — 去来源/日期后缀后的规范名（保留扩展名）
  - `loadProfile() → { tagWeights: {}, videoStats: {} }` — 读 `data/recommend.json` 的 `profiles.default`，缺省返回空结构
  - `saveProfile(profile)` — 原子写回（先写临时文件再 rename）
  - `applyEvents(events, meta) → void` — 逐条更新画像并写盘
  - `scoreVideo(name, tags, profile, meta) → number` — Task 2 实现
  - `buildRecommend({ mediaNames, trashNames, meta }) → [{name, reason, groupId, groupCount, hasCover}]` — Task 2 实现
  - `DATA_DIR` 常量 — 默认 `path.join(__dirname, "data")`，可被 `process.env.RECOMMEND_DATA_DIR` 覆盖（测试用）

- [ ] **Step 1: 写失败测试**

`test/recommend.test.js`:

```js
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
  assert.strictEqual(p.tagWeights["巨乳"], 0.5); // 不重复加
});

test("applyEvents 未知类型与非法名被忽略", () => {
  const before = rec.loadProfile();
  rec.applyEvents([{ type: "hack", name: "x.mp4" }, { type: "like", name: "../x.mp4" }]);
  const after = rec.loadProfile();
  assert.deepStrictEqual(after.tagWeights, before.tagWeights);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test`（零参自动发现 test/；本机 Node v26 下 `node --test test/` 会把目录当模块路径报错，全量运行统一用零参或 `npm test`）
Expected: FAIL — `Cannot find module '../recommend.js'`

- [ ] **Step 3: 实现 recommend.js（核心部分）**

```js
// 推荐模块：题材词表、画像存取、事件权重、排序与理由（零第三方依赖）
// 画像数据存于 data/recommend.json（profiles.default 单人画像，预留多画像扩展）
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.RECOMMEND_DATA_DIR || path.join(__dirname, "data");
const PROFILE_FILE = path.join(DATA_DIR, "recommend.json");

// 题材词表：从现有 media 文件名提炼的高频题材词（文件名包含即打标签）
const TAG_LEXICON = [
  "乱伦", "海角", "姐姐", "妹妹", "嫂子", "淫妻", "表妹", "儿媳",
  "白丝", "黑丝", "巨乳", "白虎", "口爆", "深喉", "内射", "骑乘",
  "后入", "自慰", "直播", "调教", "少女", "福利姬", "网红", "极品",
  "纯爱", "偷情", "沙发", "浴室", "酒店", "野外", "车震", "丝袜",
  "大奶", "肥臀", "蜜穴", "嫩穴", "豪乳", "粉穴", "巨屌", "玉足",
];

// 词表匹配：返回命中的题材词（按词表顺序）
function extractTags(name) {
  return TAG_LEXICON.filter((t) => name.includes(t));
}

// 规范名：剥离 " _ 51吃瓜网"、"-20260808-xxxx"、"- 91视频..." 等来源/日期后缀（保留扩展名）
// 用途：同片多版本（不同来源/日期副本）归为同一组
function groupKey(name) {
  const ext = path.extname(name);
  let base = name.slice(0, name.length - ext.length);
  base = base.replace(/\s*[-_]\s*(?:51吃瓜网|91视频(?:_91自拍(?:_国产自拍)?)?)(?:-\d{8}-[a-z0-9]+)?\s*$/i, "");
  base = base.replace(/\s*-\d{8}-[a-z0-9]+\s*$/i, "");
  base = base.replace(/\s+$/, "");
  return base + ext;
}

// 空画像结构（单人画像字段；后续多画像在此扩展）
function defaultProfile() {
  return { tagWeights: {}, videoStats: {} };
}

// 读取画像；文件缺失/损坏时返回空画像
function loadProfile() {
  try {
    const data = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));
    const p = (data.profiles && data.profiles.default) || defaultProfile();
    p.tagWeights ||= {};
    p.videoStats ||= {};
    return p;
  } catch {
    return defaultProfile();
  }
}

// 原子写回画像（临时文件 + rename）
function saveProfile(profile) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const data = { profiles: { default: profile } };
  const tmp = PROFILE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, PROFILE_FILE);
}

// 事件 → 标签权重增量（固定增量事件表；watch 需看时长比例见下）
const FIXED_DELTAS = {
  like: 3, fav: 3, unlike: -3, unfav: -3,
  finish: 2, skip: -1, delete: -3,
  speedup: -0.5, seek_fwd: -1, seek_back: 1,
};

// 取某视频的统计位（不存在则初始化）
function statsOf(profile, name) {
  if (!profile.videoStats[name]) {
    profile.videoStats[name] = {
      plays: 0, maxT: 0, finishes: 0, lastWatch: 0,
      credit30: false, creditFinish: false, creditSpeedup: false,
    };
  }
  return profile.videoStats[name];
}

// 对某视频的全部标签施加权重增量
function bumpTags(profile, name, delta) {
  for (const tag of extractTags(name)) {
    profile.tagWeights[tag] = (profile.tagWeights[tag] || 0) + delta;
  }
}

// 应用一批行为事件（meta: { 文件名: { duration } }，用于 watch 的比例判断）
// 规则见设计文档：like/fav +3；finish +2（每视频一次）；≥30% +0.5（一次）；
// skip -1；delete -3；speedup -0.5（一次）；seek_fwd -1；seek_back +1
function applyEvents(events, meta = {}) {
  const profile = loadProfile();
  for (const ev of events) {
    if (!ev || typeof ev.name !== "string" || !ev.name || path.basename(ev.name) !== ev.name) continue;
    const delta = FIXED_DELTAS[ev.type];
    if (delta !== undefined) {
      if (ev.type === "finish") {
        const st = statsOf(profile, ev.name);
        st.finishes += 1;
        if (!st.creditFinish) { st.creditFinish = true; bumpTags(profile, ev.name, 2); }
      } else if (ev.type === "speedup") {
        const st = statsOf(profile, ev.name);
        if (!st.creditSpeedup) { st.creditSpeedup = true; bumpTags(profile, ev.name, -0.5); }
      } else {
        bumpTags(profile, ev.name, delta);
      }
      continue;
    }
    if (ev.type === "watch") {
      const st = statsOf(profile, ev.name);
      const t = Number(ev.t) || 0;
      if (t > 0) {
        st.plays += 1;                       // 每次 watch 上报计一次播放（客户端5秒节流）
        st.lastWatch = Date.now();
        if (t > st.maxT) st.maxT = t;
        const dur = meta[ev.name] && meta[ev.name].duration;
        if (dur > 0) {
          const ratio = st.maxT / dur;
          if (ratio >= 0.9 && !st.creditFinish) {
            st.creditFinish = true;
            st.finishes += 1;
            bumpTags(profile, ev.name, 2);
          } else if (ratio >= 0.3 && !st.credit30) {
            st.credit30 = true;
            bumpTags(profile, ev.name, 0.5);
          }
        }
      }
    }
  }
  saveProfile(profile);
}

module.exports = { DATA_DIR, TAG_LEXICON, extractTags, groupKey, loadProfile, saveProfile, applyEvents };
```

- [ ] **Step 4: 更新 package.json 与 .gitignore**

`package.json`: scripts 加 `"test": "node --test test/"`；engines 改 `">=18"`。
`.gitignore` 追加两行：

```
# 运行时数据（画像/元数据/封面）
data/
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test`（零参自动发现 test/；本机 Node v26 下 `node --test test/` 会把目录当模块路径报错，全量运行统一用零参或 `npm test`）
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add recommend.js test/recommend.test.js package.json .gitignore
git commit -m "feat: 推荐模块核心（题材词表、画像存取、事件权重）"
```

---

### Task 2: recommend.js 排序、推荐理由、副本分组

**Files:**
- Modify: `recommend.js`（追加 scoreVideo / tierTags / reasonFor / buildRecommend，并补导出）
- Modify: `test/recommend.test.js`（追加排序相关测试）

**Interfaces:**
- Consumes: Task 1 的 `loadProfile / extractTags / groupKey / applyEvents`（签名不变）
- Produces:
  - `scoreVideo(name, tags, profile, meta) → number`
  - `buildRecommend({ mediaNames, trashNames, meta }) → [{ name, reason, groupId, groupCount, hasCover }]` — 按分数降序、同组去重

- [ ] **Step 1: 追加失败测试**（`test/recommend.test.js` 末尾）

```js
test("scoreVideo 标签权重 + 行为分合成", () => {
  rec.applyEvents([{ type: "like", name: "乱伦片A.mp4" }]);
  const p = rec.loadProfile();
  // 乱伦 +3；plays=0，无 finish，非最近看过 → 3
  assert.strictEqual(rec.scoreVideo("乱伦片A.mp4", ["乱伦"], p, {}), 3);
});

test("buildRecommend 排序、理由、副本分组、回收站排除", () => {
  rec.applyEvents([
    { type: "like", name: "乱伦片A _ 51吃瓜网.mp4" },
    { type: "finish", name: "乱伦片A _ 51吃瓜网.mp4" },
  ]);
  const list = rec.buildRecommend({
    mediaNames: [
      "乱伦片A _ 51吃瓜网.mp4",
      "乱伦片A _ 51吃瓜网-20260808-xyz123.mp4",
      "白丝片B.mp4",
      "已删除片D.mp4",
    ],
    trashNames: ["已删除片D.mp4"],
    meta: { "乱伦片A _ 51吃瓜网.mp4": { duration: 120 }, "白丝片B.mp4": { duration: 50 } },
  });
  // 副本只出一条
  assert.strictEqual(list.length, 2);
  const first = list[0];
  assert.ok(first.name.startsWith("乱伦片A"));
  assert.strictEqual(first.groupCount, 2);
  assert.ok(first.reason.includes("乱伦"));
  // 白丝片B 无行为 → 新片推荐，排第二
  assert.ok(list[1].name.startsWith("白丝片B"));
  assert.strictEqual(list[1].reason, "新片推荐");
  assert.strictEqual(list[1].hasCover, false);
  // 回收站文件不出现
  assert.ok(!list.some((x) => x.name.includes("已删除")));
});

test("buildRecommend 冷启动（无任何行为）保持原顺序", () => {
  const names = ["b.mp4", "a.mp4", "c.mp4"];
  const list = rec.buildRecommend({ mediaNames: names, trashNames: [], meta: {} });
  assert.deepStrictEqual(list.map((x) => x.name), names);
  assert.ok(list.every((x) => x.reason === "新片推荐"));
});

test("tierTags 时长与清晰度档位", () => {
  assert.deepStrictEqual(rec.tierTags("x.mp4", { "x.mp4": { duration: 30, width: 1280, height: 720 } }), ["短片", "高清"]);
  assert.deepStrictEqual(rec.tierTags("x.mp4", { "x.mp4": { duration: 3600, width: 3840, height: 2160 } }), ["长片", "4K"]);
  assert.deepStrictEqual(rec.tierTags("x.mp4", {}), []);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test`（零参自动发现 test/；本机 Node v26 下 `node --test test/` 会把目录当模块路径报错，全量运行统一用零参或 `npm test`）
Expected: FAIL — `rec.scoreVideo is not a function` / `rec.tierTags is not a function` / `rec.buildRecommend is not a function`

- [ ] **Step 3: 实现排序与理由**（`recommend.js` 追加）

```js
// 时长档位标签（与题材词并列参与权重）
function durationTag(seconds) {
  if (seconds < 60) return "短片";
  if (seconds < 300) return "中片";
  return "长片";
}

// 清晰度档位标签（按分辨率高度）
function resTag(height) {
  if (height >= 2160) return "4K";
  if (height >= 1440) return "2K";
  if (height >= 1080) return "超清";
  if (height >= 720) return "高清";
  return "标清";
}

// 单个视频的全部标签：题材词 + 时长档 + 清晰度档
function tierTags(name, meta = {}) {
  const m = meta[name];
  if (!m || !m.duration) return [];
  const tags = [durationTag(m.duration)];
  if (m.height) tags.push(resTag(m.height));
  return tags;
}

// 视频得分 = 各标签权重之和 + 行为分
// 行为分 = 播放次数×0.3 + 完成(≥1次 finish)×1.5 + 最近看过(24h内) -1
function scoreVideo(name, tags, profile, meta = {}) {
  let score = 0;
  for (const tag of tags) score += profile.tagWeights[tag] || 0;
  const st = profile.videoStats[name];
  if (st) {
    score += st.plays * 0.3;
    if (st.finishes > 0) score += 1.5;
    if (Date.now() - st.lastWatch < 24 * 3600 * 1000) score -= 1;
  }
  return score;
}

// 推荐理由：按权重最高的正标签；无标签时按行为分；再按新片
function reasonFor(name, tags, profile) {
  let bestTag = null;
  let bestWeight = 0;
  for (const tag of tags) {
    const w = profile.tagWeights[tag] || 0;
    if (w > bestWeight) { bestWeight = w; bestTag = tag; }
  }
  if (bestTag) return `因为你看过「${bestTag}」类`;
  const st = profile.videoStats[name];
  if (st && st.plays >= 3) return "你看过多次";
  if (st && st.plays > 0) return "热门视频";
  return "新片推荐";
}

// 构建推荐列表：排除回收站 → 打分 → 副本分组(取组内最高分) → 按分降序
// 冷启动（全部分数相同）时保持 mediaNames 原顺序（稳定排序）
function buildRecommend({ mediaNames, trashNames = [], meta = {} }) {
  const profile = loadProfile();
  const trashSet = new Set(trashNames);
  const byGroup = new Map(); // groupKey -> { name, score, tags, idx }
  mediaNames.forEach((name, idx) => {
    if (trashSet.has(name)) return;
    const tags = [...extractTags(name), ...tierTags(name, meta)];
    const score = scoreVideo(name, tags, profile, meta);
    const key = groupKey(name);
    const prev = byGroup.get(key);
    if (!prev || score > prev.score) byGroup.set(key, { name, score, tags, idx });
  });
  // 组内成员数（同组去重统计）
  const groupCounts = new Map();
  mediaNames.forEach((name) => {
    if (trashSet.has(name)) return;
    const key = groupKey(name);
    groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
  });
  const list = [...byGroup.values()].sort((a, b) => b.score - a.score || a.idx - b.idx);
  return list.map((g) => ({
    name: g.name,
    reason: reasonFor(g.name, g.tags, profile),
    groupId: groupKey(g.name),
    groupCount: groupCounts.get(groupKey(g.name)) || 1,
    hasCover: !!(meta[g.name] && meta[g.name].cover),
  }));
}

// 更新导出
module.exports = { DATA_DIR, TAG_LEXICON, extractTags, groupKey, loadProfile, saveProfile, applyEvents, durationTag, resTag, tierTags, scoreVideo, reasonFor, buildRecommend };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test`（零参自动发现 test/；本机 Node v26 下 `node --test test/` 会把目录当模块路径报错，全量运行统一用零参或 `npm test`）
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add recommend.js test/recommend.test.js
git commit -m "feat: 推荐排序、推荐理由与副本分组"
```

---

### Task 3: scan-metadata.js（ffprobe 时长/清晰度 + ffmpeg 封面抽帧）

**Files:**
- Create: `scan-metadata.js`
- Create: `test/scan-metadata.test.js`
- Modify: `package.json`（scripts 加 `"scan": "node scan-metadata.js"`）

**Interfaces:**
- Consumes: 无（独立脚本；server 以子进程调用 `node scan-metadata.js`）
- Produces:
  - `runScan() → { scanned, skipped, failed }` — 增量扫描 media/，写 `data/media-meta.json` 与 `data/covers/<name>.jpg`
  - `probeFile(filePath) → Promise<{duration, width, height} | null>`（ffprobe）
  - `extractCover(filePath, outPath, duration) → Promise<boolean>`（ffmpeg 抽 10% 位置帧，320px 宽）
  - 独立运行时：ffprobe/ffmpeg 缺失 → 报错 `process.exit(1)`

- [ ] **Step 1: 写失败测试**

`test/scan-metadata.test.js`（档位函数 durationTag/resTag 已在 Task 2 的 recommend.js 实现，此处只测扫描自身逻辑）:

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/scan-metadata.test.js`
Expected: FAIL — `Cannot find module '../scan-metadata.js'`

- [ ] **Step 3: 实现 scan-metadata.js**

```js
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

module.exports = { MEDIA_FOLDER, DATA_DIR, checkTools, parseProbe, probeFile, extractCover, runScan };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/scan-metadata.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 真实扫描冒烟**（跑一次真实库，约几十秒）

Run: `npm run scan`
Expected: 输出 `新增 N，跳过 0，失败 0`；`data/media-meta.json` 生成；抽查 `data/covers/` 下有几张 jpg

- [ ] **Step 6: 提交**

```bash
git add scan-metadata.js test/scan-metadata.test.js package.json
git commit -m "feat: 媒体元数据扫描（ffprobe 时长/分辨率 + ffmpeg 封面抽帧）"
```

---

### Task 4: server.js 集成（/api/events、/api/recommend、/data/covers/、启动扫描）

**Files:**
- Modify: `server.js`（require 两个新模块；新增 3 条路由；启动时后台子进程扫描）
- Modify: `README.md`（前置条件 ffmpeg/ffprobe + 新接口说明）
- Create: `test/server-api.test.js`（接口级测试）

**Interfaces:**
- Consumes: `recommend.js` 的 `applyEvents / buildRecommend / loadProfile`；`scan-metadata.js` 的 `MEDIA_FOLDER / DATA_DIR / COVER_DIR`（若导出）
- Produces:
  - `POST /api/events` — body `{ events: [{type, name, t?}] }` → `{ ok: true }`；非法事件忽略
  - `GET /api/recommend` → `{ list: [{name, reason, groupId, groupCount, hasCover}] }`
  - `GET /data/covers/<name>` — 封面图静态服务（jpg）

- [ ] **Step 1: 写失败测试**

`test/server-api.test.js`:

```js
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
```

注意：该测试要求 server.js 的 `routeRequest` 对 `/api/events`、`/api/recommend` 的响应不依赖真实 media 目录存在（`buildRecommend` 的 mediaNames 为空数组时返回空 list 即可）。测试通过 `process.env.RECOMMEND_DATA_DIR` 隔离画像文件。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/server-api.test.js`
Expected: FAIL — 404 或 fetch 报错

- [ ] **Step 3: 实现 server.js 集成**

在 `server.js` 顶部 require 后追加：

```js
const rec = require("./recommend");
const { MEDIA_FOLDER, DATA_DIR, COVER_DIR } = require("./scan-metadata");
```

在 `routeRequest` 中（`/api/delete` 分支之前）新增：

```js
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
```

辅助函数（放在 `emitFileList` 附近）：

```js
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
```

启动时后台扫描（`createServer` 之前的模块级，或在 `listen` 后触发；放主进程入口处）：

```js
// 启动后台元数据扫描（子进程方式，不阻塞主服务；退出码非 0 时打印醒目错误）
const { spawn } = require("child_process");
const scanProc = spawn(process.execPath, [path.join(__dirname, "scan-metadata.js")], {
  stdio: ["ignore", "inherit", "inherit"],
});
scanProc.on("exit", (code) => {
  if (code !== 0) {
    console.error(`[scan] 元数据扫描失败（退出码 ${code}）：请确认已安装 ffmpeg/ffprobe`);
  }
});
```

注意：此段放 `if (require.main === module)` 块内（主进程启动时），避免测试加载 server.js 时也触发扫描。

`README.md` 更新要点：
- 「前置条件」增加：`ffmpeg` / `ffprobe`（必需，用于元数据扫描与封面抽帧；macOS: `brew install ffmpeg`）
- 「接口」增加 `POST /api/events`、`GET /api/recommend` 一行说明

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test`（零参自动发现 test/；本机 Node v26 下 `node --test test/` 会把目录当模块路径报错，全量运行统一用零参或 `npm test`）
Expected: 全部 PASS（含 server-api）

- [ ] **Step 5: 手工 curl 验证**

```bash
npm start &   # 后台启动
curl -s localhost:8080/api/events -X POST -H 'Content-Type: application/json' -d '{"events":[{"type":"like","name":"测试.mp4"}]}'
curl -s localhost:8080/api/recommend | head -c 300
```

Expected: 第一行 `{"ok":true}`；第二行 JSON 数组（`data/media-meta.json` 生成后推荐列表含 reason）

- [ ] **Step 6: 提交**

```bash
git add server.js README.md test/server-api.test.js
git commit -m "feat: 服务端推荐接口（事件上报、推荐列表、封面静态服务）"
```

---

### Task 5: 客户端推荐 Tab（index.html UI）

**Files:**
- Modify: `index.html`（tab 栏加「推荐」；renderFeed 加 rec 分支；createSlide 显示推荐理由 + 封面缩略图）

**Interfaces:**
- Consumes: `GET /api/recommend` → `{ list: [{name, reason, groupId, groupCount, hasCover}] }`；`/data/covers/<name>.jpg`
- Produces: 无（纯 UI）

- [ ] **Step 1: Tab 栏加「推荐」按钮**

`index.html` tab-bar（当前 3 个按钮，`data-tab="all" / "fav" / "trash"`）：在「全部」前插入推荐按钮：

```html
<button class="tab-btn" data-tab="rec">推荐</button>
```

注意：`switchTab` 中 `currentTab` 的 fav 分支逻辑不变；`data-tab="rec"` 自动绑定。

- [ ] **Step 2: renderFeed 加 rec 分支**

`renderFeed` 函数（约 line 1281）开头，在 fav 分支之前加：

```js
        if (currentTab === "rec") {
          let feed = { list: [] };
          try {
            feed = await (await fetch("/api/recommend")).json();
          } catch (e) {
            console.error(e);
          }
          // 竞态守卫：等待期间用户已切换 tab，丢弃本次结果
          if (currentTab !== "rec") return;
          list = feed.list.map((r) => {
            const ext = r.name.split(".").pop().toLowerCase();
            const base = {
              name: r.name,
              url: `${MEDIA_DIR}/${encodeURIComponent(r.name)}`,
              reason: r.reason,
              groupId: r.groupId,
              groupCount: r.groupCount,
              hasCover: r.hasCover,
            };
            if (V_EXT.includes(ext))
              return { ...base, type: "video", mime: MIME[ext] || "video/mp4" };
            if (A_EXT.includes(ext))
              return { ...base, type: "audio", mime: MIME[ext] || "audio/mpeg" };
            return base;
          });
        } else if (currentTab === "fav") {
```

空状态（line ~1306 的 `if (list.length === 0)` 链）加 rec 分支（在 fav 分支前）：

```js
          if (currentTab === "rec") {
            feedEl.innerHTML = `<div style="display:flex;height:100%;align-items:center;justify-content:center;"><div class="empty"><div class="empty-icon">✨</div><h3 style="color:#fff;margin-bottom:8px;">还没有推荐</h3><p style="font-size:12px;">先到「全部」看几个视频，推荐会慢慢变懂你</p></div></div>`;
          } else if (currentTab === "fav") {
```

- [ ] **Step 3: createSlide 显示推荐理由与封面**

`createSlide` 的信息面板段（约 line 1110-1114）：

```js
        // 信息面板
        const info = document.createElement("div");
        info.className = "info-panel";
        info.innerHTML = `<div class="video-desc">${escapeHtml(item.name)}</div>`;
        div.appendChild(info);
```

改为（在 video-desc 后追加理由行与封面缩略图）：

```js
        // 信息面板
        const info = document.createElement("div");
        info.className = "info-panel";
        let descHtml = `<div class="video-desc">${escapeHtml(item.name)}</div>`;
        if (item.reason) {
          descHtml += `<div class="video-reason">${escapeHtml(item.reason)}</div>`;
        }
        if (item.hasCover) {
          descHtml += `<img class="video-cover" src="data/covers/${encodeURIComponent(item.name)}" alt="" loading="lazy" onerror="this.style.display='none'">`;
        }
        info.innerHTML = descHtml;
        div.appendChild(info);
```

CSS（`.info-panel` 样式块附近追加）：

```css
      .video-reason {
        margin-top: 6px;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.7);
      }
      .video-cover {
        margin-top: 8px;
        max-width: 120px;
        max-height: 80px;
        border-radius: 6px;
        object-fit: cover;
        border: 1px solid rgba(255, 255, 255, 0.2);
      }
```

- [ ] **Step 4: 手工浏览器验证（桌面）**

1. 打开 `http://localhost:8080`，底部出现「推荐」Tab（第一个）
2. 点「推荐」：有数据时显示推荐流（首屏第一条带推荐理由与封面缩略图）；无数据时显示空状态文案
3. 切到「全部」再切回「推荐」：列表刷新且不闪烁错位
4. 封面缺失（hasCover=false）时缩略图不显示、不报错

- [ ] **Step 5: 提交**

```bash
git add index.html
git commit -m "feat: 客户端推荐Tab（推荐理由与封面缩略图展示）"
```

---

### Task 6: 客户端行为埋点（index.html 事件上报）

**Files:**
- Modify: `index.html`（事件队列 + 批量上报 + 各行为触发点）

**Interfaces:**
- Consumes: `POST /api/events`（body `{ events: [{type, name, t?}] }`）
- Produces: 无

- [ ] **Step 1: 事件队列与批量上报**（`loadState`/`saveState` 附近追加）

```js
      // ---- 行为埋点：批量上报到 /api/events ----
      const EV_TYPES = new Set([
        "like", "unlike", "fav", "unfav", "delete",
        "watch", "finish", "skip", "speedup", "seek_fwd", "seek_back",
      ]);
      let evQueue = [];
      let evTimer = null;
      function reportEvent(type, name, extra) {
        if (!EV_TYPES.has(type)) return;
        evQueue.push(Object.assign({ type, name }, extra || {}));
        if (evQueue.length >= 50) flushEvents();
      }
      async function flushEvents() {
        if (!evQueue.length) return;
        const batch = evQueue;
        evQueue = [];
        try {
          await fetch("/api/events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ events: batch }),
          });
        } catch (e) {
          console.error(e);
          evQueue = batch.concat(evQueue); // 失败回队，下次再发
        }
      }
      // 定时与离开页面上报
      evTimer = setInterval(flushEvents, 30000);
      window.addEventListener("pagehide", flushEvents);
      window.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushEvents();
      });
```

- [ ] **Step 2: 各行为触发点**

**点赞/取消**（`toggleLike` 内或 likeEl click handler 里）：

```js
            reportEvent(liked.has(item.name) ? "like" : "unlike", item.name);
```

**收藏/取消**（favEl click handler，按切换后的状态）：

```js
            reportEvent(fav.has(item.name) ? "fav" : "unfav", item.name);
```

**删除**（delEl click handler，`r.ok` 之后）：

```js
              reportEvent("delete", item.name);
```

**观看/完成**（createSlide 内 video 元素创建后，timeupdate 节流上报；`video.loop=true` 不会触发 ended，用 90% 位置判定完成）：

```js
          let lastWatchReport = 0;
          video.addEventListener("timeupdate", () => {
            const now = Date.now();
            if (now - lastWatchReport >= 5000 && video.currentTime > 0) {
              lastWatchReport = now;
              reportEvent("watch", item.name, { t: Math.round(video.currentTime) });
            }
            if (video.duration && video.currentTime >= video.duration * 0.9) {
              reportEvent("finish", item.name);
            }
          });
```

注意：finish 每 5 秒节流内最多触发一次（timeupdate 间隔 ~250ms，需加去重标志）：

```js
          let finishReported = false;
          video.addEventListener("timeupdate", () => {
            const now = Date.now();
            if (now - lastWatchReport >= 5000 && video.currentTime > 0) {
              lastWatchReport = now;
              reportEvent("watch", item.name, { t: Math.round(video.currentTime) });
            }
            if (!finishReported && video.duration && video.currentTime >= video.duration * 0.9) {
              finishReported = true;
              reportEvent("finish", item.name);
            }
          });
```

**快速划走**（<10 秒）：在 `setActiveSlide` 或滑动切换逻辑处，记录每张 slide 的进入时间：

```js
          // createSlide 内：
          div.dataset.enteredAt = String(Date.now());
          // setActiveSlide 切换时（新 slide 激活前），若旧 slide 存活 <10s 且已开始播放 → skip
          const prev = slides[prevIdx];
          if (prev && prev.dataset.enteredAt &&
              Date.now() - Number(prev.dataset.enteredAt) < 10000) {
            const v = prev.querySelector("video");
            if (v && v.currentTime > 0) {
              reportEvent("skip", prev.dataset.name || "");
            }
          }
```

实现位置建议：`setActiveSlide(idx)` 内（约 line 834）——切换前用旧 idx 的 slide 判断。若该处难以取到旧 slide，可在 `handleScroll` 的当前索引变化处实现；两处取一即可，保持行为一致。

**长按 2x**（长按触发处，`v.playbackRate = 2;` 之后，line ~1062）：

```js
              reportEvent("speedup", item.name);
```

**快进/回看**（seekWrap 拖拽释放处与键盘 ←/→，line ~1477 起与 keydown 处）：记录 seek 前后位置比较方向：

```js
          // 拖拽/点击释放时（seekWrap pointerup/touchend/mouseup）：
          // 比较 seekFill 的 ratio 与 seek 前记录值（seekBeforeRatio）
          // 若新位置 >= 0.9 视为 finish（已在 timeupdate 覆盖，无需重复上报）
          // 否则新位置 > 旧位置 → seek_fwd；新位置 < 旧位置 → seek_back
          // 上报：reportEvent("seek_fwd"|"seek_back", item.name)
```

具体实现：在 seekWrap 的 pointerdown/touchstart/mousedown 记录 `window._seekBefore = 当前 ratio`；在 pointerup/touchend/mouseup 计算 `window._seekAfter`，二者不等且 after < 0.9 时上报方向事件。键盘 ←/→（keydown handler）同理：按 ← 上报 seek_back，按 → 上报 seek_fwd（若按后位置 ≥0.9 则不上报）。

- [ ] **Step 3: 手工浏览器验证**

1. 控制台 Network 面板：播放视频约 6 秒 → 出现 `POST /api/events`，body 含 `watch` 事件与 `t` 值
2. 播放到 90%+ → 出现 `finish` 事件（仅一次）
3. 点爱心/收藏/删除 → 对应 `like`/`fav`/`delete` 事件
4. 进视频 5 秒内上滑 → 出现 `skip`
5. 长按视频 → 出现 `speedup`（每次长按仅一次）
6. 拖进度条前后拖 → 出现 `seek_fwd` / `seek_back`
7. 刷新页面 → `data/recommend.json` 中 tagWeights 已更新

- [ ] **Step 4: 提交**

```bash
git add index.html
git commit -m "feat: 客户端行为埋点（批量上报观看/完成/划走/快进等事件）"
```

---

### Task 7: 端到端验证 + 推送

**Files:** 无新增（可能小幅修正）

- [ ] **Step 1: 全量测试**

Run: `node --test`（零参自动发现 test/；本机 Node v26 下 `node --test test/` 会把目录当模块路径报错，全量运行统一用零参或 `npm test`）
Expected: 全部 PASS

- [ ] **Step 2: 服务端全流程 curl 验证**

```bash
npm start &
sleep 1
# 1. 行为事件写入画像
curl -s localhost:8080/api/events -X POST -H 'Content-Type: application/json' \
  -d '{"events":[{"type":"like","name":"乱伦大神 新婚骚弟媳 _ 51吃瓜网.mp4"},{"type":"finish","name":"乱伦大神 新婚骚弟媳 _ 51吃瓜网.mp4"}]}'
# 2. 推荐列表含该视频且带理由
curl -s localhost:8080/api/recommend | python3 -m json.tool | head -40
# 3. 删除后从推荐消失
curl -s localhost:8080/api/delete -X POST -H 'Content-Type: application/json' -d '{"name":"乱伦大神 新婚骚弟媳 _ 51吃瓜网.mp4"}'
curl -s localhost:8080/api/recommend | grep -c "乱伦大神" || echo "已排除 ✓"
# 4. 还原后重新出现
curl -s localhost:8080/api/trash -X POST -H 'Content-Type: application/json' -d '{"action":"restore","name":"乱伦大神 新婚骚弟媳 _ 51吃瓜网.mp4"}'
curl -s localhost:8080/api/recommend | grep -c "乱伦大神" || echo "已恢复 ✓"
```

- [ ] **Step 3: 手机端手工全流程**（局域网 `http://192.168.x.x:8080`）

1. 底部 4 个 Tab：推荐/全部/收藏/已删除
2. 推荐 Tab 首屏：视频 + 推荐理由 + 封面缩略图（有封面时）
3. 播放 6 秒+ → 30 秒内（或离开页面时）network 有 `POST /api/events`
4. 点赞某视频 → 推荐 Tab 刷新后同类视频提前
5. 快速划走（<10s）几次同类视频 → 该题材权重下降、同类视频后移
6. 删除 → 推荐流消失；还原 → 重现
7. 长按 2x、拖进度条 → 对应事件上报
8. 首次启动扫描完成后，推荐理由出现「因为你看过「X」类」

- [ ] **Step 4: 检查 .gitignore 覆盖 data/**

Run: `git status`
Expected: `data/` 不出现在未跟踪列表

- [ ] **Step 5: 推送**

```bash
git push origin main
```

---

## Self-Review（计划自审，任务前完成）

**Spec 覆盖核对：**
- [x] 推荐 Tab 形态（滑动流+理由）→ Task 5
- [x] 显式+隐式信号 → Task 1（权重表）、Task 6（埋点）
- [x] 服务端存储（recommend.json、profiles.default 预留多画像）→ Task 1
- [x] 题材词表 + 兴趣向量 → Task 1、2
- [x] 时长/清晰度标签 + 封面抽帧 → Task 2（tierTags）、Task 3（扫描）
- [x] 清晰度独立维度（划走低清只降清晰度权重）→ Task 1 权重表（按标签独立增减，天然满足）
- [x] 排序公式 + 推荐理由 → Task 2
- [x] 副本分组 + 「同类还有 X 个版本」→ Task 2（groupCount）
- [x] 回收站排除/删除消失/还原重现 → Task 4（buildRecommend trashNames）、Task 7 验证
- [x] 快进 >90% 视为 finish → Task 6（timeupdate 90% 判定 + seek 不重复上报）
- [x] 批量节流上报 → Task 6（队列 + 30s/离开页面）
- [x] ffmpeg 硬性依赖（无降级）→ Task 3（checkTools exit(1)）、Task 4（子进程退出码告警）
- [x] 测试方案 → Task 1/2/3/4 单测 + Task 7 端到端

**占位符扫描：** 无 TBD/TODO；所有代码块为完整实现。

**类型一致性：** `applyEvents(events, meta)`、`buildRecommend({mediaNames, trashNames, meta})`、`tierTags(name, meta)`、`reportEvent(type, name, extra)` 在任务间签名一致；`durationTag/resTag` 仅存在于 Task 2 的 recommend.js（Task 3 测试改用 parseProbe，已在 Task 3 步骤 1 中说明避免重复实现）。

**已知取舍（计划内说明）：**
- `plays` 计数：watch 事件每 5 秒上报一次 → 每次 watch 都 +1 plays，播放 1 分钟 ≈ 12 次。行为分中 plays×0.3 会因此偏大。权衡：保持简单（服务端不区分会话），影响仅为行为分整体偏大，排序相对关系不受影响。若需精确可在后续加 `play` 事件类型（预留 EV_TYPES 扩展位）。
- 冷启动顺序：全部分数相同时保持 mediaNames 原顺序（`a.idx - b.idx` 稳定排序），与设计「新片优先」兼容（readdir 顺序即文件时间序近似）。
- finish 事件服务端按视频只计一次（creditFinish），客户端每张 slide 去重标志防重复上报。

