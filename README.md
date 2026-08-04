# 狼波周期指数 · Wolfy Wave Index

**[English version below ↓](#wolfy-wave-index)**

以**区块高度**为唯一横轴的比特币四年周期图表。主图为 2011 年至今的完整 BTC/USD 行情（狼波着色 / K 线 / 折线三种展示），副图为「狼波周期指数」——一个纯区块制的周期位置指标；牛熊区间着色、减半日竖线与未来推演直接画在图上，价格与链上高度实时更新。

纯静态站：无框架、无构建、无后端，克隆即可运行，可直接部署 GitHub Pages。

## 狼波周期指数是什么

### 概览

狼波周期指数（Wolfy Wave Index，WWI）是一个纯区块制的比特币周期位置指标：不使用价格、成交量或任何链上活动数据，唯一输入是**区块高度**。指数在 0 与 1 之间往复运行——0 = 理论熊市底部，1 = 理论牛市顶部。

### 模型

指数由三条结构性假设唯一确定：

1. **周期锚定减半**：每 210,000 个区块（≈ 4 年）发生一次减半，一个减半间隔即一个完整周期。
2. **牛三熊一**：每个周期中牛市占 157,500 块（3/4），熊市占 52,500 块（1/4）。
3. **减半居牛市正中**：牛市区间 = 减半高度 ± 78,750 块，其余为熊市。

### 计算公式

对任意区块高度 `h`，先求其在周期内的相位 `s`：

```
s = (h + 78,750) mod 210,000

WWI(h) = s / 157,500                  s < 157,500（牛市段）
WWI(h) = 1 − (s − 157,500) / 52,500   s ≥ 157,500（熊市段）
```

牛市段以恒定速率每块 +1/157,500 从 0 升至 1，熊市段以每块 −1/52,500 从 1 降回 0；减半时刻恰为 WWI = 0.5。

### 解读

- 上行段 = 模型牛市，下行段 = 模型熊市。读数须结合方向：同一数值每个周期出现两次（升、降各一次）。
- 数值即周期进度：牛市段中 WWI 为牛市已完成比例，熊市段中 1 − WWI 为熊市已完成比例。
- 区块高度完全可预测（平均每 10 分钟一块），指数的未来路径可以精确推演——图中虚线段即未来推演。
- 全站将指数值映射到蓝（0）→ 红（1）色谱：狼波着色模式、副图指数线与右侧色标同一映射。

### 特性与局限

- **完全确定**：WWI 是区块高度的纯函数，无任何可调参数，任何人可独立复算。
- **无价格反馈**：指数刻画周期时点而非估值水平，不会因行情涨跌而移动。
- **假设依赖**：有效性取决于「四年减半周期 + 牛三熊一结构」持续成立；市场结构性改变将削弱其现实解释力。

## 页面功能

- **区块高度主横轴**：减半线严格等距（210,000 块一格），底部刻度轴同时显示高度与 `≈` 日期，十字线有「高度 ≈ 日期」浮标；
- **三种展示模式**：狼波着色（折线逐点上色，颜色 = 该处指数值）/ K 线 / 折线；日（144 块）/ 周（1,008 块）/ 月（4,368 块）分桶；对数 / 线性坐标；
- **牛熊夹心着色**：上缘贴价格线、下缘贴副图指数线；未来推演区没有价格上缘、满高显示，实时推进的价格线会逐步「吃掉」它；减半日与牛熊市标注各有独立显隐开关；
- **实时数据**：价格走 Bitstamp WebSocket（逐笔成交 + 盘口中间价，秒级跳动），链上高度 60 秒轮询，日线尾部 5 分钟增量合并；顶栏读数带变化闪烁与脉动指示灯；
- **悬停信息卡**：聚合该位置的区块高度、≈ 日期、价格、涨跌幅、指数值与周期阶段；
- **其他**：首屏自动适配全部历史、个性化设置（主题 / 语言 / 坐标 / 类型 / 粒度 / 标注）持久化、中英文与深浅主题一键切换、内置指标说明弹窗（顶栏「?」）。

## 数据与精度

- `data/btc-daily.json` — Bitstamp BTC/USD 日线快照（随仓库分发）；页面加载时从 Bitstamp 拉最近数据实时合并，失败回退 Coinbase，再失败显示快照并提示。刷新：`node scripts/fetch-history.mjs`（Node ≥ 18）。
- `data/btc-heights.json` — 高度 ↔ 日期映射锚点：**每 144 块（一根日 K 的桶宽）一个真实区块头时间戳**，从创世块铺到生成当日（6,600+ 锚点），四次减半的插值日期与真实日期精确一致；页面运行时另从 mempool.space 实时补「当前高度」锚点。刷新：`node scripts/fetch-heights.mjs`。
- 未来日期按平均出块速度外推，全站以 `≈` 标注——横轴的唯一真实坐标是区块高度。

## 本地运行

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

不能直接双击 index.html（`file://` 下无法 fetch 本地数据文件）。

## 部署

纯静态，无构建步骤。GitHub Pages：Settings → Pages → `main` 分支根目录即可（仓库已含 `.nojekyll`）。

## 调整参数

全部集中在 [js/config.js](js/config.js)：周期常量（`HALVING_INTERVAL`、`WAVE_BULL_HALF`）、分桶粒度（`BLOCK_BUCKETS`）、枢轴搜索窗口（`PIVOT_WINDOWS`，顶底由实际行情自动算出、不硬编码日期）、狼波色谱（`WAVE_COLOR_STOPS`）与两套主题配色（`THEMES`）。

## 技术栈

[TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) v5.2.0（内置于 `vendor/`，Apache-2.0），全部图内标注用 series primitives 纯 Canvas 渲染。UI 遵循 [simple-table-design-system](https://github.com/wolfyxbt/simple-table-design-system) 数据终端设计语言：系统字体栈、数字一律等宽、颜色只用于语义。无框架、无依赖、无构建。

## 作者

杀破狼 WolfyXBT · [@wolfyxbt](https://x.com/wolfyxbt)

---

# Wolfy Wave Index

A Bitcoin four-year-cycle chart with **block height as its only x-axis**. The main pane shows the full BTC/USD history since 2011 (Wave Color / candles / line), and the sub-pane shows the Wolfy Wave Index — a block-native cycle-position indicator. Bull/bear shading, halving lines and future projection are drawn directly on the chart; price and chain height update in real time.

Pure static site: no framework, no build step, no backend. Clone and serve; deploys straight to GitHub Pages.

## What is the Wolfy Wave Index

### Overview

The Wolfy Wave Index (WWI) is a block-native Bitcoin cycle-position indicator. It uses no price, volume, or on-chain activity data — its only input is **block height**. The index oscillates between 0 and 1: 0 = theoretical bear-market bottom, 1 = theoretical bull-market top.

### Model

The index is fully determined by three structural assumptions:

1. **Cycles anchor to halvings**: one halving every 210,000 blocks (≈ 4 years); one halving interval is one full cycle.
2. **3 : 1 bull-to-bear split**: each cycle spends 157,500 blocks (3/4) in the bull phase and 52,500 blocks (1/4) in the bear phase.
3. **The halving sits at the bull midpoint**: bull phase = halving height ± 78,750 blocks; the remainder is the bear phase.

### Calculation

For any block height `h`, take its phase `s` within the cycle:

```
s = (h + 78,750) mod 210,000

WWI(h) = s / 157,500                  s < 157,500  (bull)
WWI(h) = 1 − (s − 157,500) / 52,500   s ≥ 157,500  (bear)
```

The index climbs 0 → 1 at a constant +1/157,500 per block in the bull phase and falls 1 → 0 at −1/52,500 per block in the bear phase; at every halving, WWI = 0.5 exactly.

### Interpretation

- Rising segment = model bull market, falling segment = model bear market. Read the value together with its direction: every value occurs twice per cycle (once rising, once falling).
- The value is cycle progress: in the bull phase WWI is the fraction of the bull completed; in the bear phase 1 − WWI is the fraction of the bear completed.
- Block height is fully predictable (≈ one block per 10 minutes), so the index's future path can be projected exactly — the dashed segment on the chart.
- Site-wide, values map onto a blue (0) → red (1) spectrum: Wave Color mode, the sub-pane line and the right-hand color scale share this mapping.

### Properties & Limitations

- **Fully deterministic**: WWI is a pure function of block height with no tunable parameters — anyone can recompute it independently.
- **No price feedback**: it marks cycle position, not valuation, and never moves in response to price.
- **Assumption-dependent**: its validity rests on the 4-year halving cycle and the 3 : 1 structure continuing to hold; a structural market change would weaken its explanatory power.

## Features

- **Block-height x-axis**: halving lines strictly equidistant (one per 210,000 blocks); the bottom axis shows height plus `≈` dates, with a "height ≈ date" crosshair badge;
- **Three chart styles** (Wave Color paints the price line point-by-point with the index spectrum / candles / line), D (144-block) / W (1,008) / M (4,368) bucketing, log / linear scale;
- **Bull/bear sandwich shading**: top edge hugs the price line, bottom edge hugs the index line; the future has no price edge and renders full-height — the advancing live price "eats" into it; halving and bull/bear marks have independent toggles;
- **Real-time**: Bitstamp WebSocket price (per-trade + order-book mid), 60 s chain-height polling, 5 min candle merges; live dots and change flashes in the top bar;
- **Hover card** aggregating block height, ≈ date, price, change, index value and phase;
- Full-history auto-fit on first load, persisted preferences (theme / language / scale / style / bucket / marks), Chinese & English UI, dark & light themes, built-in methodology dialog (the "?" button).

## Data & Accuracy

- `data/btc-daily.json` — Bitstamp BTC/USD daily snapshot (shipped with the repo); merged live at load, Coinbase fallback. Refresh: `node scripts/fetch-history.mjs` (Node ≥ 18).
- `data/btc-heights.json` — height ↔ date anchors: **one real block-header timestamp every 144 blocks** (6,600+ anchors from genesis), interpolated halving dates match the real ones exactly; a live tip anchor is added at runtime from mempool.space. Refresh: `node scripts/fetch-heights.mjs`.
- Future dates are extrapolated from the average block rate and always marked `≈` — the only true coordinate is block height.

## Run locally

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

Opening index.html via `file://` won't work (local data files can't be fetched).

## Deploy

Static, no build. GitHub Pages: Settings → Pages → `main` branch, root (`.nojekyll` included).

## Configuration

Everything lives in [js/config.js](js/config.js): cycle constants (`HALVING_INTERVAL`, `WAVE_BULL_HALF`), bucket sizes (`BLOCK_BUCKETS`), pivot search windows (`PIVOT_WINDOWS` — tops/bottoms are computed from actual prices, never hardcoded), the wave spectrum (`WAVE_COLOR_STOPS`) and both theme palettes (`THEMES`).

## Tech

[TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) v5.2.0 (vendored, Apache-2.0); all in-chart annotations are canvas-rendered series primitives. UI follows the [simple-table-design-system](https://github.com/wolfyxbt/simple-table-design-system) data-terminal language: system font stacks, monospace numerals, color = meaning only. No framework, no dependencies, no build.

## Creator

WolfyXBT · [@wolfyxbt](https://x.com/wolfyxbt)
