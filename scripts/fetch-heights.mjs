// 一次性快照脚本：每 144 块（一根日 K 的桶宽）取一个真实区块头时间戳锚点，
// 用于「日期 ↔ 区块高度」插值映射——每根日 K 的边界都是真实链上时间，
// 插值误差小于日期的日级显示粒度。
// 数据源：mempool.space 与 blockstream.info 轮询（Esplora 同款接口，
// 每次调用返回自该高度起往下 10~15 个区块头）。全量约 6,700 次请求，
// 并发 6、失败指数退避重试、断点续传（进度存 CKPT，成功后清除）。
// 默认增量：复用已有 data/btc-heights.json 的锚点，只补抓新块（每周约 7 个）。
// 用法：node scripts/fetch-heights.mjs   （可选 CKPT=/path/to/ckpt.json，FULL=1 全量重抓）
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const STEP = 144;
const HOSTS = [
  'https://mempool.space/api/v1/blocks/',
  'https://blockstream.info/api/blocks/',
];
const CKPT = process.env.CKPT ?? join(tmpdir(), 'wolfy-heights-ckpt.json');
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'btc-heights.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 链上最新高度：锚点铺到最后一个完整的 144 块桶
const tipRes = await fetch('https://mempool.space/api/blocks/tip/height');
if (!tipRes.ok) throw new Error(`tip HTTP ${tipRes.status}`);
const tip = Number(await tipRes.text());
const targets = [];
for (let h = 0; h <= tip; h += STEP) targets.push(h);

// 断点续传：已抓到的 {height: timestamp}
const done = existsSync(CKPT) ? JSON.parse(readFileSync(CKPT, 'utf8')) : {};
// 增量模式（默认）：复用已有快照的锚点——真实区块头时间戳不会变——只补抓
// 其后的新锚点；最末两个锚点仍重抓，规避上次抓取时靠近链顶的重组风险。
// FULL=1 强制全量重抓
if (!process.env.FULL && existsSync(OUT)) {
  const prev = JSON.parse(readFileSync(OUT, 'utf8')).anchors;
  for (const [ts, h] of prev.slice(0, -2)) done[h] ??= ts;
}
const todo = targets.filter((h) => done[h] === undefined);
console.log(`目标 ${targets.length} 个锚点（高度 0 → ${targets.at(-1)}），待抓 ${todo.length}`);

async function fetchTimestamp(h, attempt = 0) {
  const base = HOSTS[(h / STEP + attempt) % HOSTS.length];
  try {
    const res = await fetch(base + h, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const b = (await res.json()).find((x) => x.height === h);
    if (!b) throw new Error(`响应中缺少高度 ${h}`);
    return b.timestamp;
  } catch (e) {
    if (attempt >= 6) throw new Error(`高度 ${h} 抓取失败：${e.message}`);
    await sleep(1000 * 2 ** attempt + Math.random() * 500); // 退避后换源重试
    return fetchTimestamp(h, attempt + 1);
  }
}

let fetched = 0;
const queue = [...todo];
async function worker() {
  for (;;) {
    const h = queue.shift();
    if (h === undefined) return;
    done[h] = await fetchTimestamp(h);
    fetched += 1;
    if (fetched % 200 === 0) {
      writeFileSync(CKPT, JSON.stringify(done));
      console.log(`进度 ${fetched}/${todo.length}`);
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
writeFileSync(CKPT, JSON.stringify(done));

const anchors = targets.map((h) => [done[h], h]);

// 校验：时间与高度都严格递增（144 块 ≈ 一天，矿工时间戳 ±2h 偏差不可能倒序）
for (let i = 1; i < anchors.length; i++) {
  if (anchors[i][0] <= anchors[i - 1][0] || anchors[i][1] <= anchors[i - 1][1]) {
    console.error(`锚点非递增：#${i}`, anchors[i - 1], anchors[i]);
    process.exit(1);
  }
}

const out = { generated: new Date().toISOString(), source: 'mempool.space + blockstream.info', anchors };
writeFileSync(OUT, JSON.stringify(out));
unlinkSync(CKPT);
console.log(`OK: ${anchors.length} 个锚点（高度 ${anchors[0][1]} → ${anchors.at(-1)[1]}，本次新抓 ${todo.length}）已写入 ${OUT}`);
