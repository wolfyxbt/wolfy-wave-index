// 区块高度轴：日期 ↔ 高度插值映射、按块数分桶聚合、时间轴延伸、
// 狼波周期指数（纯区块制）。
// 锚点 = 每 144 块（一根日 K 的桶宽）一个真实区块头时间戳 (timestamp, height)，
// 每根日 K 的边界都是真实链上时间，插值误差小于日期的日级显示粒度。
import { DAY, WAVE_BULL_HALF, HALVING_INTERVAL } from './config.js';
import { timeoutSignal, mapLimit } from './util.js';

// 狼波周期指数：高度的纯函数，0 = 熊底，1 = 牛顶。
// 牛市 = 减半 ± WAVE_BULL_HALF（0→1 线性），熊市 = 其余区块（1→0 线性），
// 按减半网格无限周期延拓，与现实时间和价格无关
export function waveIndexAt(h) {
  const k = Math.round(h / HALVING_INTERVAL);
  const d = h - k * HALVING_INTERVAL; // 距最近减半的有符号偏移 ∈ [-105000, +105000)
  if (Math.abs(d) <= WAVE_BULL_HALF) {
    return (d + WAVE_BULL_HALF) / (2 * WAVE_BULL_HALF);
  }
  const bearLen = HALVING_INTERVAL - 2 * WAVE_BULL_HALF;
  const into = d > 0 ? d - WAVE_BULL_HALF : d + HALVING_INTERVAL - WAVE_BULL_HALF;
  return 1 - into / bearLen;
}

// 未来视界：当前高度之后第 4 个理论熊底高度——
// 图表右侧完整铺出未来三轮周期（含 2028/2032/2036 三次减半
// 与各自的牛熊区间），滚轮缩小即可查看
export function waveHorizonHeight(h) {
  return (Math.floor((h + WAVE_BULL_HALF) / HALVING_INTERVAL) + 4) * HALVING_INTERVAL - WAVE_BULL_HALF;
}

let _anchors = []; // [ts, height] 升序
let _liveAnchor = false; // 尾部是否为运行时追加的「现在」锚点
let _fileEnd = 0; // 内置表自身的末尾高度（运行时补齐的部分在它之后，单独缓存）

const ANCHOR_STEP = 144;
const GAP_CACHE_KEY = 'wolfy-anchors-ext'; // 运行时补齐的锚点（高度 > 内置表末尾）
// Esplora 同款接口：返回自该高度起往下 10~15 个区块头；两家轮换、失败换源
const ANCHOR_HOSTS = ['https://mempool.space/api/v1/blocks/', 'https://blockstream.info/api/blocks/'];

export async function loadHeightAnchors() {
  const res = await fetch('./data/btc-heights.json', { signal: timeoutSignal(15000) });
  if (!res.ok) throw new Error(`btc-heights.json HTTP ${res.status}`);
  _anchors = (await res.json()).anchors;
  _liveAnchor = false;
  _fileEnd = _anchors.at(-1)[1];
  // 并入上次访问时补齐并缓存的锚点（内置表更新后与之重叠的部分自动作废）
  try {
    addStaticAnchors(JSON.parse(localStorage.getItem(GAP_CACHE_KEY) ?? '[]'));
  } catch { /* 缓存不可用或损坏：忽略 */ }
}

// 不含「现在」锚点的末尾高度
const staticEnd = () => (_liveAnchor ? _anchors.at(-2) : _anchors.at(-1))[1];

// 把真实区块头锚点并入表尾（升序、去重、剔除非递增的异常项），「现在」锚点重新挂到末尾
function addStaticAnchors(pairs) {
  const live = _liveAnchor ? _anchors.pop() : null;
  _liveAnchor = false;
  for (const [ts, h] of pairs.slice().sort((a, b) => a[1] - b[1])) {
    const last = _anchors.at(-1);
    if (!Number.isFinite(ts) || !Number.isFinite(h) || h <= last[1] || ts <= last[0]) continue;
    _anchors.push([ts, h]);
  }
  if (live) pushLive(live[0], live[1]);
}

function pushLive(ts, h) {
  if (_liveAnchor) { _anchors.pop(); _liveAnchor = false; }
  const last = _anchors.at(-1);
  if (Number.isFinite(h) && h > last[1] && ts > last[0]) {
    _anchors.push([ts, h]);
    _liveAnchor = true;
  }
}

async function fetchBlockTimestamp(h, attempt) {
  const base = ANCHOR_HOSTS[(h / ANCHOR_STEP + attempt) % ANCHOR_HOSTS.length];
  const res = await fetch(base + h, { signal: timeoutSignal(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const b = (await res.json()).find((x) => x.height === h);
  if (!b) throw new Error(`响应中缺少高度 ${h}`);
  return b.timestamp;
}

// 运行时补齐内置表末尾到链顶之间的锚点（每 144 块一个真实区块头时间戳），
// 并发 4，结果缓存到 localStorage，下次打开只补新增部分。内置表再久不更新
// 也不失真，只是首次访问多几次请求（表每周自动刷新时缺口 ≤ 7 个）。
// 距链顶 6 块以内不取（重组风险）；遇到失败就在该处停下，下次访问续补
let _gapFilling = false;
export async function fillAnchorGap(tip, onDone) {
  if (_gapFilling || !Number.isFinite(tip)) return;
  const heights = [];
  for (let h = staticEnd() + ANCHOR_STEP; h <= tip - 6; h += ANCHOR_STEP) heights.push(h);
  if (!heights.length) return;
  _gapFilling = true;
  try {
    const got = await mapLimit(heights, 4, async (h) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return [await fetchBlockTimestamp(h, attempt), h];
        } catch { /* 换源再试一次 */ }
      }
      return null;
    });
    const firstMiss = got.indexOf(null);
    const pairs = firstMiss < 0 ? got : got.slice(0, firstMiss);
    if (!pairs.length) return;
    addStaticAnchors(pairs);
    try {
      localStorage.setItem(GAP_CACHE_KEY, JSON.stringify(
        _anchors.filter(([, h], i) => h > _fileEnd && !(_liveAnchor && i === _anchors.length - 1)),
      ));
    } catch { /* 存不下就下次再补 */ }
    onDone?.(pairs.length);
  } finally {
    _gapFilling = false;
  }
}

// 调试用：锚点表概况
export const getAnchorStats = () => ({ count: _anchors.length, fileEnd: _fileEnd, end: staticEnd(), live: _liveAnchor });

// 链上最新高度：HTTP 单次请求（轮询兜底用；推送链路见 main.js connectHeightStream）
export async function fetchTipHeight() {
  const res = await fetch('https://mempool.space/api/blocks/tip/height', { signal: timeoutSignal(8000) });
  if (!res.ok) throw new Error(`mempool.space HTTP ${res.status}`);
  const tip = Number(await res.text());
  if (!Number.isFinite(tip)) throw new Error('mempool.space 返回的高度不是数字');
  return tip;
}

// 每拿到一个新高度（轮询或推送）就维护一个「现在」锚点，让最近的映射精确到
// 当前链上高度。原地更新而非逐块追加：相邻单块锚点会把泊松噪声灌进外推斜率
export function setTipAnchor(tip) {
  pushLive(Math.floor(Date.now() / 1000), tip);
}

// 未来外推的基线跨度：≥ 4,320 块（≈ 30 天）。相邻锚点间隔太短时，
// 单块耗时的泊松噪声（一块可能 30 秒也可能 40 分钟）会被放大到未来
// 上万块，预测日期一次刷新能跳一个月——斜率必须取足够宽的窗口
const EXTRAP_SPAN_BLOCKS = 4320;

function interp(pairs, x, xi, yi) {
  const n = pairs.length;
  if (x <= pairs[0][xi]) {
    const [a, b] = [pairs[0], pairs[1]];
    return a[yi] + ((x - a[xi]) / (b[xi] - a[xi])) * (b[yi] - a[yi]);
  }
  if (x >= pairs[n - 1][xi]) {
    const b = pairs[n - 1];
    // 从尾部向前找高度跨度足够的基线锚点（pairs = [ts, height]）
    let ai = n - 2;
    while (ai > 0 && b[1] - pairs[ai][1] < EXTRAP_SPAN_BLOCKS) ai--;
    const a = pairs[ai];
    return b[yi] + ((x - b[xi]) / (b[xi] - a[xi])) * (b[yi] - a[yi]);
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pairs[mid][xi] <= x) lo = mid;
    else hi = mid;
  }
  const [a, b] = [pairs[lo], pairs[lo + 1]];
  return a[yi] + ((x - a[xi]) / (b[xi] - a[xi])) * (b[yi] - a[yi]);
}

// UTC 秒 → 区块高度（分段线性，可外推）
export const heightAt = (ts) => Math.round(interp(_anchors, ts, 0, 1));
// 区块高度 → UTC 秒（逆映射，用于给高度标注近似日期）
export const timeAtHeight = (h) => Math.round(interp(_anchors, h, 1, 0));

// 日线 → 按固定块数分桶的 K 线。bar.time = 桶起始高度（数字，天然单调递增，
// 与现有 timeToLogical/标注体系直接兼容）。桶偶尔被快速出块跳过时补
// whitespace 占位，保证横轴严格线性。
export function aggregateByBlocks(dailyCandles, bucketSize) {
  const out = [];
  for (const c of dailyCandles) {
    if (c.open === undefined) continue;
    const b = Math.floor(heightAt(c.time + DAY) / bucketSize) * bucketSize;
    const last = out.at(-1);
    if (last && last.time === b) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
    } else if (last && b > last.time) {
      for (let t = last.time + bucketSize; t < b; t += bucketSize) out.push({ time: t });
      out.push({ time: b, open: c.open, high: c.high, low: c.low, close: c.close });
    } else if (!last) {
      out.push({ time: b, open: c.open, high: c.high, low: c.low, close: c.close });
    }
  }
  return out;
}

// 高度轴向未来延伸（whitespace 占位到 untilHeight）
export function extendBlocks(bars, untilHeight, bucketSize) {
  const out = bars.slice();
  for (let t = bars.at(-1).time + bucketSize; t <= untilHeight; t += bucketSize) out.push({ time: t });
  return out;
}

// 高度轴向创世块回填（whitespace 占位）：价格数据虽从 2013 年开始，
// 但区块 0 之后的牛熊区域、减半线与狼波指数都是可推算的
export function prependBlocks(bars, bucketSize) {
  if (!bars.length || bars[0].time <= 0) return bars;
  const head = [];
  for (let t = 0; t < bars[0].time; t += bucketSize) head.push({ time: t });
  return head.concat(bars);
}
