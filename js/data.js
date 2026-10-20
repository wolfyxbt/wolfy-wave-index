// 数据管线：行情无内置快照，全部现场拉取。Bitstamp 日线分页并行（全量历史
// 2013 年起约 6 页，一秒内到齐），失败回退 Coinbase；尾部定时增量合并。
import { DAY } from './config.js';
import { timeoutSignal, mapLimit } from './util.js';

// 按时间戳去重并升序
function dedupeSort(rows) {
  const map = new Map();
  for (const c of rows) map.set(c.time, c);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

// Bitstamp：从 sinceTs 拉到今天。日线逐日连续、每页最多 1000 根，各页起点可以
// 预先算出，全部并行请求（历史越长页数越多，但总耗时≈一次往返）
export async function fetchBitstamp(sinceTs) {
  const nowSec = Math.floor(Date.now() / 1000);
  const starts = [];
  for (let s = sinceTs; s <= nowSec; s += 1000 * DAY) starts.push(s);
  const pages = await mapLimit(starts, 6, async (start) => {
    const url = `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=${DAY}&limit=1000&start=${start}`;
    const res = await fetch(url, { signal: timeoutSignal(10000) });
    if (!res.ok) throw new Error(`Bitstamp HTTP ${res.status}`);
    const json = await res.json();
    return json.data.ohlc.map((r) => ({
      time: Number(r.timestamp),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
    }));
  });
  return dedupeSort(pages.flat());
}

// Coinbase 备用：从 sinceTs 拉到现在，每次最多 300 根，按窗口并行
//（限 3 路：公共接口限流较严）。返回降序数组 [t, low, high, open, close, vol]
export async function fetchCoinbase(sinceTs) {
  const nowSec = Math.floor(Date.now() / 1000);
  const windows = [];
  for (let s = sinceTs; s <= nowSec; s += 300 * DAY) windows.push([s, Math.min(s + 299 * DAY, nowSec)]);
  const pages = await mapLimit(windows, 3, async ([startSec, endSec]) => {
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${DAY}`
      + `&start=${new Date(startSec * 1000).toISOString()}&end=${new Date(endSec * 1000).toISOString()}`;
    const res = await fetch(url, { signal: timeoutSignal(10000) });
    if (!res.ok) throw new Error(`Coinbase HTTP ${res.status}`);
    const rows = await res.json();
    return rows.map(([t, low, high, open, close]) => ({ time: t, open, high, low, close }));
  });
  return dedupeSort(pages.flat());
}

// 按时间戳合并，extra 覆盖 base 的重叠部分
export function mergeCandles(base, extra) {
  return dedupeSort([...base, ...extra]);
}

// 补齐内部缺口（用 whitespace 占位），保证数组严格逐日连续——
// 标注的「时间 → 逻辑坐标」查表依赖这一点
export function fillGaps(candles) {
  const out = [];
  let gaps = 0;
  for (const c of candles) {
    if (out.length) {
      for (let t = out.at(-1).time + DAY; t < c.time; t += DAY) {
        out.push({ time: t });
        gaps++;
      }
    }
    out.push(c);
  }
  if (gaps > 0) console.warn(`数据存在 ${gaps} 天缺口，已用空白占位补齐`);
  return out;
}
