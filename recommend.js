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
