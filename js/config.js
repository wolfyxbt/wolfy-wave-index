// ★ 全站唯一需要调整的配置文件 ★
// 顶底日期不在这里硬编码——牛顶 = 窗口内最高价那天，熊底 = 窗口内最低价那天，
// 由 pivots.js 从实际行情数据中自动算出。这里只给"粗略搜索窗口"。

export const DAY = 86400;

// 'YYYY-MM-DD' → UTC 零点 unix 秒。全站时间一律用 UTC 秒（数字），不要用日期字符串。
export const D = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
};

// 枢轴搜索窗口：按顶→底→顶…交替；每个窗口的起点 = 上一个枢轴的日期，
// 这里只需给出窗口的结束日期（最后一个窗口到最新数据为止）。
export const PIVOT_WINDOWS = [
  { type: 'top',    from: D('2013-01-01'), to: D('2014-06-30') }, // ≈2013-11-30
  { type: 'bottom', to: D('2016-01-31') },                        // ≈2015-01-14
  { type: 'top',    to: D('2018-06-30') },                        // ≈2017-12-17
  { type: 'bottom', to: D('2019-12-31') },                        // ≈2018-12-15
  { type: 'top',    to: D('2022-06-30') },                        // ≈2021-11-10
  { type: 'bottom', to: D('2023-06-30') },                        // ≈2022-11-21
  { type: 'top',    to: Infinity },                               // 进行中周期的历史最高 ≈2025-10-06
];

// 行情历史起点（现场从交易所拉取，无内置快照）；枢轴搜索窗口也从这天开始
export const HISTORY_START = D('2013-01-01');

// K 线分桶粒度（块，约等于 日/周/月）
export const BLOCK_BUCKETS = { day: 144, week: 1008, month: 4368 };

// 减半周期：每 210,000 块一次
export const HALVING_INTERVAL = 210000;

// 狼波周期指数（纯区块制）：周期 = 210,000 块（减半到减半），牛三熊一 →
// 牛市 = 157,500 块且减半在正中间，即 减半 ± 78,750 块；熊市 = 其余 52,500 块。
// 不参考现实时间与实际价格顶底，整条锯齿仅由减半区块网格推导
export const WAVE_BULL_HALF = 78750;
// 横轴向预测终点之后延伸的块数（右侧留白，约 45 天）
export const EXTEND_MARGIN_BLOCKS = 6480;

// 数据终端设计语言：不带 webfont，界面文字用系统无衬线、数字一律系统等宽
export const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
export const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

// 狼波色谱（参照 RSI 彩虹渐变）：0 = 蓝（熊底）→ 1 = 红（牛顶）。
// 折线逐点着色、右侧色标、读数文字与牛熊夹心填充共用同一映射
export const WAVE_COLOR_STOPS = [
  [0.00, [38, 60, 219]],
  [0.25, [62, 196, 233]],
  [0.50, [72, 190, 80]],
  [0.70, [214, 223, 56]],
  [0.85, [246, 156, 28]],
  [1.00, [236, 38, 38]],
];

export function waveColor(v) {
  const x = Math.max(0, Math.min(1, v));
  for (let i = 0; i + 1 < WAVE_COLOR_STOPS.length; i++) {
    const [a, ca] = WAVE_COLOR_STOPS[i];
    const [b, cb] = WAVE_COLOR_STOPS[i + 1];
    if (x <= b) {
      const f = (x - a) / (b - a);
      const c = ca.map((v0, j) => Math.round(v0 + f * (cb[j] - v0)));
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }
  }
  return 'rgb(236, 38, 38)';
}

// 主题配色。K 线为绿涨红跌（国际惯例）；想改红涨绿跌，交换各主题的 up/down。
export const THEMES = {
  dark: {
    chartBg: '#0e1117',
    chartText: '#8b93a1',
    scaleBorder: '#323c4d',
    // 面板分隔条 hover 高亮：可拖拽调高的唯一视觉暗示
    paneSepHover: 'rgba(46, 107, 255, 0.28)',
    // up/down 须与 style.css 的 --up/--down 保持同值（同一语义一种颜色）
    up: '#089981',
    down: '#f23645',
    // 折线模式的中性线色（绿色留给「涨」语义）
    line: '#2e6bff',

    // 牛=翡翠绿、熊=玫瑰红：都带较高蓝分量，叠在深藏青底上混出干净的
    // 冷青绿/酒红，避免旧配色的沼泽绿与酱褐色。
    // 整体刻意压低存在感：色带是背景语境，视觉重心留给 K 线
    bullLabel: '#34d399',
    bearLabel: '#fb7185',

    // 牛熊夹心填充：取狼波色谱主色锚点——牛 = 色谱中点绿 #48BE50，
    // 熊 = 牛顶红 #EC2626，与折线着色/色标同一色系
    bandFillBull: 'rgba(72, 190, 80, 0.20)',
    bandFillBear: 'rgba(236, 38, 38, 0.18)',

    halving: 'rgba(46, 107, 255, 0.55)',
    halvingLabel: '#7da3ff',

    today: 'rgba(139, 147, 161, 0.65)', // 当前区块引导线

    // 十字线：中性灰线 + 面板色数值牌（默认蓝灰与全站配色不搭）
    crosshairLine: 'rgba(139, 147, 161, 0.45)',
    crosshairLabelBg: '#2a3448',

    phase: '#eab04d', // 狼波周期指数折线（0=熊底 → 1=牛顶）

    tagBg: 'rgba(14, 17, 23, 0.72)', // 标签胶囊统一底色（半透明减轻遮挡感）

    watermark: 'rgba(228, 232, 240, 0.05)',
  },
  light: {
    chartBg: '#ffffff',
    chartText: '#767d8a',
    scaleBorder: '#c6cedb',
    // 面板分隔条 hover 高亮：可拖拽调高的唯一视觉暗示
    paneSepHover: 'rgba(41, 98, 255, 0.22)',
    // up/down 须与 style.css 的 --up/--down 保持同值（同一语义一种颜色）
    up: '#089981',
    down: '#e02a3a',
    // 折线模式的中性线色（绿色留给「涨」语义）
    line: '#2962ff',

    // 与深色主题同一色相：白底上呈清爽的薄荷绿/玫瑰粉。
    // 同样压低存在感，视觉重心留给 K 线
    bullLabel: '#059669',
    bearLabel: '#e11d48',

    // 牛熊夹心填充：取狼波色谱主色锚点——牛 = 色谱中点绿 #48BE50，
    // 熊 = 牛顶红 #EC2626，与折线着色/色标同一色系
    bandFillBull: 'rgba(72, 190, 80, 0.14)',
    bandFillBear: 'rgba(236, 38, 38, 0.11)',

    halving: 'rgba(41, 98, 255, 0.50)',
    halvingLabel: '#2962ff',

    today: 'rgba(118, 125, 138, 0.70)', // 当前区块引导线

    // 十字线：中性灰线 + 深灰数值牌（十字线标签文字为白色，浅色主题也需深底）
    crosshairLine: 'rgba(118, 125, 138, 0.50)',
    crosshairLabelBg: '#5b6472',

    phase: '#c88a2d', // 狼波周期指数折线（0=熊底 → 1=牛顶）

    tagBg: 'rgba(255, 255, 255, 0.75)', // 标签胶囊统一底色（半透明减轻遮挡感）

    watermark: 'rgba(22, 26, 34, 0.05)',
  },
};

// 运行时当前主题（setTheme 原地更新，标注在重建时读取最新值）
export const COLORS = { ...THEMES.dark };
export function setTheme(name) {
  Object.assign(COLORS, THEMES[name] ?? THEMES.dark);
}
