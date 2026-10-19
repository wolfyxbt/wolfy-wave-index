// 入口编排：内置快照立即上屏 → 后台拉实时尾部 → 原地升级；
// 页面 UI（区块主轴 + 底部「高度/≈日期」双行刻度轴、分桶/主题/坐标/标注开关、
// OHLC 读数、周期状态栏、顶部标签轴）
import {
  DAY, BLOCK_BUCKETS, HALVING_INTERVAL, WAVE_BULL_HALF, COLORS, FONT, FONT_MONO, setTheme,
  WAVE_COLOR_STOPS, waveColor,
} from './config.js';
import { createChartAndSeries, applyChartTheme, setLogScale } from './chart.js';
import {
  loadSnapshot, fetchBitstampLive, fetchCoinbaseFallback,
  mergeCandles, fillGaps,
} from './data.js';
import {
  loadHeightAnchors, fetchTipHeight, setTipAnchor, heightAt, timeAtHeight,
  aggregateByBlocks, extendBlocks, prependBlocks, waveIndexAt, waveHorizonHeight,
} from './blocks.js';
import { computePivots, buildAnnotations } from './pivots.js';
import { t, setLang, I18N } from './i18n.js';
import { setSeriesData, timeToLogical, logicalToX } from './primitives/base.js';

const $ = (id) => document.getElementById(id);
const fmtDate = (t) => new Date(t * 1000).toISOString().slice(0, 10);
// 全站统一的日期显示格式：YYYY/MM/DD
const fmtYMD = (t) => {
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
};
// 粗刻度用的月份格式：YYYY/MM
const fmtYM = (t) => {
  const d = new Date(t * 1000);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const fmtPrice = (p) => (p >= 100 ? Math.round(p).toLocaleString('en-US') : p.toFixed(2));
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtPct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;

const THEME_KEY = 'wolfy-theme';
const LANG_KEY = 'wolfy-lang';
// 界面设置持久化：用户改过的坐标/图表类型/分桶粒度/标注显隐记在
// localStorage（与主题/语言同一机制），下次打开直接恢复个性化状态
const SCALE_KEY = 'wolfy-scale';
const STYLE_KEY = 'wolfy-style';
const TF_KEY = 'wolfy-tf';
// 标注显隐拆成两个独立开关：减半日 / 牛熊市（旧的 wolfy-annot 总开关
// 作为两者缺省值的兜底，老用户的选择不丢失）
const ANNOT_HALVING_KEY = 'wolfy-annot-halving';
const ANNOT_BANDS_KEY = 'wolfy-annot-bands';

// 狼波色谱与 waveColor 定义在 config.js（与夹心填充/色标共用同一映射）

// 读数文字用的狼波色：与折线/色标同一色谱（同一数值同一颜色）；
// 浅色主题下压暗一档——色谱中段的黄绿在白底上几乎不可读
function waveTextColor(v) {
  const c = waveColor(v);
  if (document.documentElement.dataset.theme !== 'light') return c;
  const [r, g, b] = c.match(/\d+/g).map(Number);
  const k = 0.72;
  return `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`;
}

// 提示条带 key：同一时刻只显示一条；hideNotice(key) 只收起对应来源的提示，
// 链路恢复时不会误收其他来源的提示
function showNotice(text, key = '') {
  $('notice-text').textContent = text;
  $('notice').dataset.key = key;
  $('notice').hidden = false;
}
function hideNotice(key) {
  if ($('notice').dataset.key === key) $('notice').hidden = true;
}
$('notice-close').addEventListener('click', () => { $('notice').hidden = true; });

async function init() {
  // ── 主题与语言初始化（在建图之前） ──
  let themeName = localStorage.getItem(THEME_KEY) || 'dark';
  setTheme(themeName);
  document.documentElement.dataset.theme = themeName;
  setLang(localStorage.getItem(LANG_KEY) || 'en'); // 默认英文界面
  $('loading-text').textContent = t('loading');

  // 右侧色标：按同一份色谱生成渐变，保证与折线逐点颜色严格一致
  $('ws-bar').style.background = `linear-gradient(to top, ${
    WAVE_COLOR_STOPS.map(([p, c]) => `rgb(${c[0]}, ${c[1]}, ${c[2]}) ${p * 100}%`).join(', ')
  })`;

  // ── 状态 ──
  let attached = [];       // 当前挂载的标注 primitive（主图）
  let attachedPhase = [];  // 当前挂载的副图标注（贯穿的色带与减半线）
  // 最近一次构建的标注，按类别分组（减半日与牛熊市独立显隐）
  let built = { bands: [], halvings: [] };
  let builtPhase = { bands: [], halvings: [] };
  // 当前开关状态下应挂载的集合；减半线在前 = 先挂 = 画在最底层
  const currentMainPrims = () => [
    ...(halvingOn ? built.halvings : []),
    ...(bandsOn ? built.bands : []),
  ];
  const currentPhasePrims = () => [
    ...(halvingOn ? builtPhase.halvings : []),
    ...(bandsOn ? builtPhase.bands : []),
  ];
  // 默认初始状态：标注开启、对数坐标、狼波着色、144 区块（日）；
  // 用户改过则从 localStorage 恢复（存的值非法时回落默认）
  const legacyAnnot = localStorage.getItem('wolfy-annot');
  let halvingOn = (localStorage.getItem(ANNOT_HALVING_KEY) ?? legacyAnnot) !== '0';
  let bandsOn = (localStorage.getItem(ANNOT_BANDS_KEY) ?? legacyAnnot) !== '0';
  let phaseOn = true;      // 狼波指数副图窗格显示中
  let logOn = localStorage.getItem(SCALE_KEY) !== 'linear';
  const savedStyle = localStorage.getItem(STYLE_KEY);
  // 'candles' | 'line' | 'wave'，默认狼波着色
  let chartStyle = ['candles', 'line', 'wave'].includes(savedStyle) ? savedStyle : 'wave';
  const savedTf = localStorage.getItem(TF_KEY);
  // 分桶粒度键：day=144区块 week=1,008区块 month=4,368区块
  let timeframe = BLOCK_BUCKETS[savedTf] ? savedTf : 'day';
  let daily = [];          // fillGaps 后的日线（枢轴/统计的数据源）
  let dailyReal = [];      // 仅真实日线
  let bars = [];           // 按块分桶的 bars + whitespace（图表数据源，time=桶起始高度）
  let pivots = [];
  let meta = null;         // { topPos, todayPos, predictedEnd }（单位：高度）
  let idxCache = null;
  let tipHeight = null;    // 当前链上高度（mempool.space WebSocket 推送 + HTTP 轮询兜底）
  let livePrice = null;    // 实时价格（Bitstamp WebSocket + ticker 轮询兜底）
  // 链路健康：记「最近一次证明链路在线」的时刻（ms）。高度 = HTTP 取到高度
  // 或收到任一 mempool WS 消息（含 pong）；价格 = 收到成交/盘口或 ticker 成功。
  // 指示灯与「≈」标记只看这两个时刻，不看多久没出新块——出块间隔超过
  // 半小时很常见，那不是断线
  const link = {
    heightAt: 0,
    priceAt: 0,
    heightStale: true,    // 首屏即为推算值，拿到真实数据才点亮
    priceStale: true,
    heightTried: false,   // 首次高度请求是否已有结果（页面刚打开不弹提示）
    heightNoticed: false, // 当前这轮中断是否已弹过提示
  };
  const HEIGHT_STALE_MS = 150000; // 轮询 60s × 2 + 余量；WS 在线时每 30s 有 pong
  const PRICE_STALE_MS = 90000;   // WS 盘口每秒有消息；ticker 轮询 30s × 2 + 余量
  // 价格 WebSocket 连接状态（声明在前：checkLinks 在价格流启动前就会跑）
  let wsAlive = false;
  let priceSock = null;
  let priceReconnectTimer = null;
  let watermark = null;
  let waveNow = null;      // 当前（今日）狼波指数值，十字线移开时回落显示

  const LWC = window.LightweightCharts;
  const { chart, series, lineSeries, waveLine, phaseSolid, phaseDashed } = createChartAndSeries($('chart'));
  let attachedHost = series; // 标注当前挂载的价格系列（随展示模式切换迁移）
  const styleHost = () => (chartStyle === 'line' ? lineSeries : chartStyle === 'wave' ? waveLine : series);
  // 初始可见性与默认展示模式对齐（chart.js 里 K 线是建图默认）
  series.applyOptions({ visible: chartStyle === 'candles' });
  lineSeries.applyOptions({ visible: chartStyle === 'line' });
  waveLine.applyOptions({ visible: chartStyle === 'wave' });
  if (!logOn) setLogScale(chart, false); // 持久化为线性时建图后立刻套用

  // 绘图区宽度。不能用 timeScale().width()：内置时间轴已隐藏，它返回 0
  function paneWidth() {
    try {
      return chart.paneSize().width;
    } catch {
      return $('chart').clientWidth;
    }
  }

  // 价格轴在左侧：logicalToX 给出的是面板内坐标，所有 DOM 覆盖元素
  //（底轴刻度/浮标、引导线、读数行）定位时都要加上左轴宽度
  function paneLeft() {
    try {
      return chart.priceScale('left').width() || 0;
    } catch {
      return 0;
    }
  }

  // ── 底部区块刻度轴（主行：高度；副行：对应≈日期） ──
  const blockAxis = $('block-axis');
  const bxCursor = $('bx-cursor');
  const TICK_STEPS = [1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000];

  // 逻辑坐标 → 高度（bars 反查 + 桶内插值），用于计算可见高度范围
  function heightAtLogical(l) {
    if (bars.length < 2) return null;
    const i = Math.max(0, Math.min(bars.length - 2, Math.floor(l)));
    const t0 = bars[i].time;
    const t1 = bars[i + 1].time;
    return t0 + (l - i) * (t1 - t0);
  }

  // 当前可见范围的刻度高度：底部区块轴与图内垂直网格线共用同一套
  function computeAxisTicks() {
    const range = chart.timeScale().getVisibleLogicalRange();
    const width = paneWidth();
    if (!range || !width) return null;
    const hFrom = heightAtLogical(range.from);
    const hTo = heightAtLogical(range.to);
    if (hFrom === null || hTo === null || hTo <= hFrom) return null;
    const pxPerBlock = width / (hTo - hFrom);
    const step = TICK_STEPS.find((s) => s * pxPerBlock >= 96) ?? TICK_STEPS.at(-1);
    const ticks = [];
    // 负高度不存在：刻度从区块 0 起
    for (let h = Math.max(0, Math.ceil(hFrom / step) * step); h <= hTo; h += step) ticks.push(h);
    return { ticks, step };
  }

  function renderBlockAxis() {
    const width = paneWidth();
    const res = computeAxisTicks();
    if (!res) return;
    const fmtTickDate = res.step >= 20000 ? fmtYM : fmtYMD; // 粗刻度只标到月
    const pl = paneLeft();
    for (const el of [...blockAxis.querySelectorAll('.bx-label, .bx-date, .bx-tick')]) el.remove();
    for (const h of res.ticks) {
      const x = logicalToX(chart, timeToLogical(h));
      if (x === null || x < 0 || x > width) continue;
      const tick = document.createElement('i');
      tick.className = 'bx-tick';
      tick.style.left = `${pl + x}px`;
      const label = document.createElement('span');
      label.className = 'bx-label';
      label.textContent = fmtInt(h);
      label.style.left = `${pl + x}px`;
      const date = document.createElement('span');
      date.className = 'bx-date';
      date.textContent = `≈ ${fmtTickDate(timeAtHeight(h))}`;
      date.style.left = `${pl + x}px`;
      blockAxis.append(tick, label, date);
    }
    updateNowGuide();
  }

  // 当前区块引导线 + 底轴高度数值牌（与 y 轴价格引导线对称，常驻显示）
  const nowLine = $('now-line');
  const bxNow = $('bx-now');

  function updateNowGuide() {
    const h = meta?.todayPos;
    const width = paneWidth();
    const x = h != null ? logicalToX(chart, timeToLogical(h)) : null;
    if (x === null || x < 0 || x > width) {
      nowLine.hidden = true;
      bxNow.hidden = true;
      return;
    }
    const pl = paneLeft();
    nowLine.style.left = `${pl + x}px`;
    nowLine.style.borderColor = COLORS.today;
    nowLine.hidden = false;
    // 与十字线浮标同格式（高度 ≈ 日期）；不用 title——
    // pointer-events:none 的元素 tooltip 永远弹不出来
    bxNow.textContent = `${fmtInt(h)} ≈ ${fmtYMD(timeAtHeight(h))}`;
    bxNow.hidden = false;
    // 贴近左右边缘时钳制在可视范围内，不被拦腰裁掉
    const bw = bxNow.offsetWidth;
    bxNow.style.left = `${pl + Math.max(bw / 2, Math.min(width - bw / 2, x))}px`;
  }

  // 十字线在底轴上的浮标：高度 ≈ 日期（负高度不存在，不显示）
  function updateAxisCursor(h) {
    if (h === null || h < 0) {
      bxCursor.hidden = true;
      return;
    }
    const x = logicalToX(chart, timeToLogical(h));
    const width = paneWidth();
    if (x === null || x < 0 || x > width) {
      bxCursor.hidden = true;
      return;
    }
    bxCursor.textContent = `${fmtInt(h)} ≈ ${fmtYMD(timeAtHeight(h))}`;
    bxCursor.hidden = false;
    // 贴近左右边缘时钳制在可视范围内，不被拦腰裁掉
    const cw = bxCursor.offsetWidth;
    bxCursor.style.left = `${paneLeft() + Math.max(cw / 2, Math.min(width - cw / 2, x))}px`;
  }

  chart.timeScale().subscribeVisibleLogicalRangeChange(renderBlockAxis);
  window.addEventListener('resize', renderBlockAxis);

  // ── 狼波指数副图窗格的显隐 ──
  // 隐藏 = 把两条指数系列移到主面板并设不可见（空面板被 LWC 自动移除，
  // 主图占满全高）；显示 = 移回面板 1 并恢复线性坐标、留白与 4:1 高度。
  // 开关按钮浮在窗格右上角，收起后退到图表右下角。
  const phaseBtn = $('phase-toggle');
  const phaseLegend = $('phase-legend');
  function positionPhaseToggle() {
    const hostH = $('chart').clientHeight;
    phaseBtn.style.right = '8px'; // 价格轴在左侧，右缘无轴
    let top = hostH - 28; // 收起态：贴图表右下角
    if (phaseOn) {
      try {
        const p0 = chart.paneSize(0).height;
        const p1 = chart.paneSize(1).height;
        top = p0 + Math.max(0, hostH - p0 - p1) + 5; // 面板顶 + 分隔条
      } catch { /* 布局未就绪 */ }
    }
    phaseBtn.style.top = `${top}px`;
    // 读数行贴面板左缘（左侧价格轴之右），与面板顶保持 10px（top 已含 +5）
    const inset = paneLeft() + 14;
    $('legend').style.left = `${inset}px`;
    phaseLegend.style.left = `${inset}px`;
    phaseLegend.hidden = !phaseOn;
    if (phaseOn) phaseLegend.style.top = `${top + 5}px`;
    updateNowGuide(); // 面板高度变化（拖分隔条/显隐副图）时同步重定位标记点
  }
  // 面板高度变化（拖分隔条/窗口缩放/显隐切换）都会引起画布尺寸变化
  const paneObserver = new ResizeObserver(() => positionPhaseToggle());
  function observePaneCanvases() {
    paneObserver.disconnect();
    for (const cv of $('chart').querySelectorAll('canvas')) paneObserver.observe(cv);
  }
  observePaneCanvases();
  positionPhaseToggle();

  function setPhaseVisible(on) {
    phaseOn = on;
    if (on) {
      phaseSolid.moveToPane(1);
      phaseDashed.moveToPane(1);
      phaseSolid.applyOptions({ visible: true });
      phaseDashed.applyOptions({ visible: true });
      // 新面板的价格轴是全新实例：重设线性坐标与留白
      phaseSolid.priceScale().applyOptions({
        mode: LWC.PriceScaleMode.Normal,
        scaleMargins: { top: 0.06, bottom: 0.05 },
      });
      try {
        const panes = chart.panes();
        panes[0].setStretchFactor(4);
        panes[1].setStretchFactor(1);
      } catch (e) { console.warn('副图高度设置失败（不影响功能）：', e); }
      attachedPhase = currentPhasePrims();
      for (const p of attachedPhase) phaseSolid.attachPrimitive(p);
    } else {
      for (const p of attachedPhase) phaseSolid.detachPrimitive(p);
      attachedPhase = [];
      phaseSolid.applyOptions({ visible: false });
      phaseDashed.applyOptions({ visible: false });
      phaseSolid.moveToPane(0);
      phaseDashed.moveToPane(0);
    }
    phaseBtn.classList.toggle('active', on);
    phaseLegend.hidden = !on; // 同步隐藏，不等下面的重定位回调
    requestAnimationFrame(() => {
      observePaneCanvases(); // 面板画布重建后重新观察
      positionPhaseToggle();
    });
  }

  phaseBtn.addEventListener('click', () => setPhaseVisible(!phaseOn));

  function makeWatermark() {
    try {
      watermark?.detach();
      const [big, small] = t('watermark');
      // 标题行大号无衬线（界面文字），作者行等宽字体
      //（@handle 是标识符，走数据字体）；两行同一透明度。
      // 作者行字号按实测文本宽度缩放，与标题行渲染宽度对齐
      let authorSize = 17;
      if (small) {
        const mctx = document.createElement('canvas').getContext('2d');
        mctx.font = `bold 58px ${FONT}`;
        const tw = mctx.measureText(big).width;
        mctx.font = `17px ${FONT_MONO}`;
        const aw = mctx.measureText(small).width;
        if (tw > 0 && aw > 0) authorSize = Math.round(17 * (tw / aw));
      }
      watermark = LWC.createTextWatermark(chart.panes()[0], {
        horzAlign: 'center',
        vertAlign: 'center',
        lines: [
          {
            text: big,
            color: COLORS.watermark,
            fontSize: 58,
            fontStyle: 'bold',
            fontFamily: FONT,
          },
          ...(small ? [{
            text: small,
            color: COLORS.watermark,
            fontSize: authorSize,
            fontFamily: FONT_MONO,
            lineHeight: Math.max(46, Math.round(authorSize * 1.4)),
          }] : []),
        ],
      });
    } catch (e) {
      console.warn('水印创建失败（不影响功能）：', e);
      watermark = null;
    }
  }

  // 主图价格读数（BTC/USD 右侧）：跟随十字线，移开时回落为实时价
  function updateLegendPrice(v = null) {
    const p = v ?? livePrice ?? dailyReal.at(-1)?.close;
    $('legend-price').textContent = p != null ? fmtPrice(p) : '';
  }

  // 副图标题行（DOM，与主图 OHLC 读数同一套排版）：名称 + 实时读数。
  // 读数跟随十字线，移开时回落为当前值
  function updateWaveTitle(v = waveNow) {
    // 名称与主图「BTC/USD」同款系列标识样式（加粗主文字色）
    const name = `<b>${t('paneTitleName')}</b>`;
    if (v === null) {
      phaseLegend.innerHTML = name;
      return;
    }
    phaseLegend.innerHTML =
      `${name}<b class="wave-text" style="color: ${waveTextColor(v)}">${v.toFixed(3)}</b>`;
  }

  // ── 渲染管线 ──
  // newRawDaily 为 null 时复用现有日线（分桶/主题切换）；
  // 枢轴基于日线计算，图表数据按当前粒度分桶（time = 桶起始高度）
  function render(newRawDaily, { fit = false } = {}) {
    if (newRawDaily) {
      daily = fillGaps(newRawDaily);
      dailyReal = daily.filter((c) => c.open !== undefined);
      pivots = computePivots(daily);
    }
    // 未来视界：延伸到「下下个」理论熊底，铺出完整的下一轮周期
    //（未来的减半区块与狼波周期都是可直接推算的）
    // 拿不到链上高度时按锚点外推「此刻」的高度（旧写法外推到明天零点，
    // 会比真实高度超前最多一天的块数）
    const hNow = tipHeight ?? heightAt(Math.floor(Date.now() / 1000));
    const horizonH = waveHorizonHeight(hNow);
    const bucket = BLOCK_BUCKETS[timeframe];
    const ann = buildAnnotations(pivots, hNow, horizonH);
    // 横轴覆盖 [区块 0, 未来视界]：价格数据之前与之后都用 whitespace 占位
    bars = extendBlocks(prependBlocks(aggregateByBlocks(daily, bucket), bucket), ann.extendTo, bucket);
    meta = ann.meta;
    series.setData(bars);
    // 折线/着色系列取收盘价，时间键与 K 线完全一致（不向时间轴引入新点位）；
    // 着色模式逐点上色：颜色 = 该处狼波指数（蓝 0 → 红 1）
    const realBars = bars.filter((b) => b.open !== undefined);
    lineSeries.setData(realBars.map((b) => ({ time: b.time, value: b.close })));
    waveLine.setData(realBars.map((b) => ({
      time: b.time,
      value: b.close,
      color: waveColor(waveIndexAt(b.time)),
    })));
    setSeriesData(bars);
    // 狼波周期指数：高度的纯函数，按 bars 的桶起始高度采样。
    // 实线 = 已发生，虚线 = 未来段；逐点上色 = 与着色模式同一色谱（蓝 0 → 红 1）
    const solidData = [];
    const dashedData = [];
    for (const b of bars) {
      const v = waveIndexAt(b.time);
      (b.time <= ann.meta.todayPos ? solidData : dashedData)
        .push({ time: b.time, value: v, color: waveColor(v) });
    }
    if (solidData.length && dashedData.length) dashedData.unshift(solidData.at(-1));
    phaseSolid.setData(solidData);
    phaseDashed.setData(dashedData);
    waveNow = waveIndexAt(hNow);
    updateWaveTitle();
    // 标注挂载到当前可见的价格系列
    const host = styleHost();
    for (const p of attached) attachedHost.detachPrimitive(p);
    attachedHost = host;
    built = { bands: ann.bandPrims, halvings: ann.halvingPrims };
    attached = currentMainPrims();
    for (const p of attached) attachedHost.attachPrimitive(p);
    for (const p of attachedPhase) phaseSolid.detachPrimitive(p);
    builtPhase = { bands: ann.phaseBandPrims, halvings: ann.phaseHalvingPrims };
    attachedPhase = phaseOn ? currentPhasePrims() : [];
    for (const p of attachedPhase) phaseSolid.attachPrimitive(p);
    idxCache = null;
    if (fit) {
      // 等一帧，确保 autoSize 已应用真实容器尺寸
      requestAnimationFrame(() => {
        fitAll();
        renderBlockAxis();
        positionPhaseToggle(); // 面板尺寸就绪后校正副图按钮/标题位置
      });
    } else {
      renderBlockAxis();
      positionPhaseToggle();
    }
    updateStats();
    window.wolfy = { chart, series, phaseSolid, phaseDashed, pivots, candles: daily, bars, meta }; // 调试用
  }

  // ── 顶栏统计 ──
  // 数值更新闪烁：对比上一次显示值，真正变化时底色亮起后淡出
  const lastShown = { price: NaN, height: NaN, wave: null };
  function flashValue(el, dir = null) {
    el.classList.remove('flash', 'flash-up', 'flash-down');
    void el.offsetWidth; // 强制重排以重启动画
    el.classList.add(dir === 'up' ? 'flash-up' : dir === 'down' ? 'flash-down' : 'flash');
  }

  function updateStats() {
    const last = dailyReal.at(-1);
    const prev = dailyReal.at(-2);
    if (!last) return;

    const priceNow = livePrice ?? last.close;
    updateLegendPrice();
    // 顶栏价格显示到美分：取整到美元会把逐笔成交的跳动全部抹平
    $('stat-price').textContent = `$${priceNow.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
    if (Number.isFinite(lastShown.price) && priceNow !== lastShown.price) {
      flashValue($('stat-price').closest('.stat-value'), priceNow >= lastShown.price ? 'up' : 'down');
    }
    lastShown.price = priceNow;
    if (prev) {
      const chg = (priceNow - prev.close) / prev.close;
      const el = $('stat-chg');
      el.textContent = fmtPct(chg);
      el.className = `chg ${chg >= 0 ? 'up' : 'down'}`;
    }
    // 标签页标题即行情条（TradingView 式）：窄标签从右截断，优先级
    // 从左到右排——实时跳动的价格最高、慢变的 WWI 次之、站名殿后。
    // 只放两个裸数值：六万级的跳动数字自然读作 BTC 价格，0~1 的小数
    // 自然读作 WWI，标签与涨跌幅在窄标签里只会挤掉真正的信息
    //（随 250ms 节流刷新）
    if (waveNow !== null) {
      const priceTxt = priceNow.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      document.title = `${priceTxt} · ${waveNow.toFixed(3)} · ${t('brand')}`;
    }
    // 顶栏狼波周期指数读数（颜色 = 该值的狼波色）+ 变化闪烁
    const waveEl = $('stat-wave');
    const waveText = waveNow !== null ? waveNow.toFixed(3) : '—';
    waveEl.textContent = waveText;
    waveEl.style.color = waveNow !== null ? waveTextColor(waveNow) : '';
    if (lastShown.wave !== null && waveNow !== null && waveText !== lastShown.wave) {
      flashValue(waveEl.closest('.stat-value'));
    }
    if (waveNow !== null) lastShown.wave = waveText;
    // 色标游标跟随当前指数值
    const marker = $('ws-marker');
    if (waveNow !== null) {
      marker.hidden = false;
      marker.style.bottom = `calc(${(waveNow * 100).toFixed(2)}% - 5px)`; // 10px 圆钮取中
    }
    if (!meta) return;

    // 链路中断或尚未拿到真实高度时加「≈」：全站约定，≈ = 推算值
    $('stat-height').textContent = `${link.heightStale ? '≈ ' : ''}${fmtInt(meta.todayPos)}`;
    if (Number.isFinite(lastShown.height) && Math.round(meta.todayPos) !== Math.round(lastShown.height)) {
      flashValue($('stat-height').closest('.stat-value'));
    }
    lastShown.height = meta.todayPos;
  }

  // ── 十字线 OHLC 读数（基于当前 bars） ──
  function prevRealClose(i) {
    for (let j = i - 1; j >= 0; j--) {
      if (bars[j].open !== undefined) return bars[j].close;
    }
    return null;
  }

  // ── 悬停信息卡：跟随光标，聚合该位置的全部读数 ──
  // 头部 = 区块高度 + ≈日期；行 = 色条 + 名称 + 右对齐数值
  //（开/高/低/收/涨跌幅 + 狼波指数 + 周期阶段）；
  // 悬停在未来推演区（无价格数据）时只显示区块/指数/阶段
  const tooltip = $('tooltip');
  let mouseX = 0;
  let mouseY = 0;
  // 捕获阶段监听：先于图表库内部处理更新坐标，十字线回调里拿到的
  // 一定是本次事件的位置；随移动同步重定位，避免一帧滞后
  $('chart').addEventListener('mousemove', (e) => {
    const r = $('chart').getBoundingClientRect();
    mouseX = e.clientX - r.left;
    mouseY = e.clientY - r.top;
    if (!tooltip.hidden) placeTooltip();
  }, { capture: true });
  $('chart').addEventListener('mouseleave', () => { tooltip.hidden = true; });

  // 贴着光标放置：默认右下方，越界时翻到另一侧
  function placeTooltip() {
    const host = $('chart');
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let left = mouseX + 18;
    if (left + tw > host.clientWidth - 8) left = mouseX - 18 - tw;
    let top = mouseY + 18;
    if (top + th > host.clientHeight - 8) top = mouseY - 18 - th;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function updateTooltip(param, bar) {
    if (param?.time === undefined) {
      tooltip.hidden = true;
      return;
    }
    const h = param.time;
    const row = (chip, label, val) =>
      `<div class="tt-row"><i class="tt-chip" style="background:${chip}"></i>`
      + `<span class="tt-label">${label}</span><span class="tt-val">${val}</span></div>`;
    let rows = '';
    if (bar) {
      const i = idxCache?.get(bar.time);
      const prevClose = i !== undefined ? prevRealClose(i) : null;
      const chg = prevClose ? (bar.close - prevClose) / prevClose : null;
      const dirColor = chg !== null && chg < 0 ? COLORS.down : COLORS.up;
      if (chartStyle === 'candles') {
        // K 线模式：一根蜡烛有四个价格，逐项展示
        const [o, hi, lo, cl] = t('legendOHLC');
        rows += row(dirColor, o, fmtPrice(bar.open));
        rows += row(dirColor, hi, fmtPrice(bar.high));
        rows += row(dirColor, lo, fmtPrice(bar.low));
        rows += row(dirColor, cl, fmtPrice(bar.close));
      } else {
        // 折线/狼波着色：线本体取收盘价，只展示这一个价格
        rows += row(dirColor, t('ttPrice'), fmtPrice(bar.close));
      }
      if (chg !== null) rows += row(dirColor, t('ttChange'), fmtPct(chg));
    }
    const v = waveIndexAt(h);
    rows += row(waveTextColor(v), t('waveLabel'), v.toFixed(3));
    // 周期阶段：狼波上行段 = 牛市，下行段 = 熊市
    const s = (((h + WAVE_BULL_HALF) % HALVING_INTERVAL) + HALVING_INTERVAL) % HALVING_INTERVAL;
    const isBull = s < 2 * WAVE_BULL_HALF;
    rows += row(
      isBull ? COLORS.bullLabel : COLORS.bearLabel,
      t('ttPhase'),
      isBull ? t('bull') : t('bear'),
    );
    tooltip.innerHTML =
      `<div class="tt-head"><b>${t('ttBlock', fmtInt(h))}</b> ≈ ${fmtYMD(timeAtHeight(h))}</div>${rows}`;
    tooltip.hidden = false;
    placeTooltip();
  }

  chart.subscribeCrosshairMove((param) => {
    // 读数直接按时间键查 bars，不依赖价格系列（K线/折线切换均可用）
    let hovered = null;
    if (param?.time !== undefined) {
      if (!idxCache) idxCache = new Map(bars.map((x, i) => [x.time, i]));
      const b = bars[idxCache.get(param.time)];
      if (b && b.open !== undefined) hovered = b;
    }
    updateTooltip(param, hovered);
    updateLegendPrice(hovered ? hovered.close : null);
    // 狼波指数读数跟随十字线（未来虚线段也有值），移开时回落到当前值
    const w = param?.time !== undefined
      ? (param.seriesData.get(phaseSolid) ?? param.seriesData.get(phaseDashed))
      : null;
    updateWaveTitle(w ? w.value : waveNow);
    // 底轴浮标：十字线位置的高度与≈日期
    updateAxisCursor(param?.time !== undefined ? param.time : null);
  });

  // 默认视图完整呈现全部价格历史：横向 [首根真实K线, 今日] 两侧各留
  // 3% 安全留白（未来推演区在右侧，滚轮缩小/右拖即可查看）；
  // 纵向由左轴自动缩放完成，scaleMargins 已留出上下安全边距
  function fitAll() {
    const first = bars.findIndex((b) => b.open !== undefined);
    if (first < 0 || !meta) return;
    const to = timeToLogical(meta.todayPos);
    const pad = (to - first) * 0.03;
    chart.timeScale().setVisibleLogicalRange({ from: first - pad, to: to + pad });
  }

  // ── 工具栏 ──
  const tfButtons = [...document.querySelectorAll('#tf-group button')];
  tfButtons.forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.tf === timeframe) return;
    timeframe = btn.dataset.tf;
    tfButtons.forEach((b) => b.classList.toggle('active', b === btn));
    localStorage.setItem(TF_KEY, timeframe);
    render(null);
    fitAll();
  }));

  // K线 / 折线 / 狼波着色切换：迁移标注宿主并保留缩放
  const styleButtons = [...document.querySelectorAll('#style-group button')];
  const scaleButtons = [...document.querySelectorAll('#scale-group button')];
  // HTML 里写死的是默认态；恢复持久化设置后同步按钮高亮
  tfButtons.forEach((b) => b.classList.toggle('active', b.dataset.tf === timeframe));
  styleButtons.forEach((b) => b.classList.toggle('active', b.dataset.style === chartStyle));
  scaleButtons.forEach((b) => b.classList.toggle('active', (b.dataset.scale === 'log') === logOn));
  $('halving-toggle').classList.toggle('active', halvingOn);
  $('bands-toggle').classList.toggle('active', bandsOn);
  styleButtons.forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.style === chartStyle) return;
    chartStyle = btn.dataset.style;
    styleButtons.forEach((b) => b.classList.toggle('active', b === btn));
    localStorage.setItem(STYLE_KEY, chartStyle);
    series.applyOptions({ visible: chartStyle === 'candles' });
    lineSeries.applyOptions({ visible: chartStyle === 'line' });
    waveLine.applyOptions({ visible: chartStyle === 'wave' });
    render(null); // 标注重新挂载到当前可见的价格系列
  }));

  // ── 语言：刷新所有静态文案（图内标注由 render 重建时套用） ──
  const TF_KEYS = { day: 'tfDay', week: 'tfWeek', month: 'tfMonth' };
  const STYLE_KEYS = { candles: 'styleCandles', line: 'styleLine', wave: 'styleWave' };
  function applyStaticLang() {
    document.documentElement.lang = I18N.lang === 'zh' ? 'zh-CN' : 'en';
    $('brand-name').textContent = t('brand');
    const sub = t('brandSub');
    $('brand-sub').textContent = sub;
    $('brand-sub').hidden = !sub;
    $('loading-brand').textContent = t('brand');
    $('label-height').textContent = t('axisName');
    $('stat-wave-label').textContent = t('statWave'); // 中文全称 / 英文缩写 WWI
    $('stat-wave-cell').title = t('titleWaveStat');
    tfButtons.forEach((b) => { b.textContent = t(TF_KEYS[b.dataset.tf]); });
    styleButtons.forEach((b) => { b.textContent = t(STYLE_KEYS[b.dataset.style]); });
    $('label-price').textContent = t('priceLabel');
    $('bx-name').textContent = t('axisName');
    // tooltip / aria 文案同样随语言刷新（否则切 EN 后悬停仍弹中文）
    $('lang-toggle').title = t('titleLang');
    $('theme-toggle').title = t('titleTheme');
    $('tf-group').title = t('titleTf');
    $('style-group').title = t('titleStyle');
    $('scale-group').title = t('titleScale');
    $('halving-toggle').title = t('titleAnnotHalving');
    $('bands-toggle').title = t('titleAnnotBands');
    $('phase-toggle').title = t('titlePhase');
    $('wave-scale').title = t('titleWaveScale');
    $('notice-close').setAttribute('aria-label', t('closeLabel'));
    $('about-toggle').title = t('titleAbout');
    $('about-title').textContent = t('aboutTitle');
    $('about-body').innerHTML = t('aboutHtml');
    $('about-close').setAttribute('aria-label', t('closeLabel'));
    scaleButtons.forEach((b) => { b.textContent = t(b.dataset.scale === 'log' ? 'log' : 'linear'); });
    $('ws-top').textContent = t('scaleTop');
    $('ws-bottom').textContent = t('scaleBottom');
    updateLinkUI(); // 链路状态的悬停说明也随语言刷新
  }
  applyStaticLang();

  // ── 指标说明弹窗：按钮打开；点遮罩 / 关闭按钮 / Esc 关闭 ──
  // 离场沿到场路径反向播放（.closing 动画），播完才真正 hidden；
  // 退场途中再次打开会打断退场、立即回到打开态（动画可打断）
  const aboutOverlay = $('about-overlay');
  function openAbout() {
    aboutOverlay.classList.remove('closing');
    aboutOverlay.hidden = false;
  }
  function closeAbout() {
    if (aboutOverlay.hidden || aboutOverlay.classList.contains('closing')) return;
    aboutOverlay.classList.add('closing');
    const done = () => {
      if (aboutOverlay.classList.contains('closing')) {
        aboutOverlay.hidden = true;
        aboutOverlay.classList.remove('closing');
      }
    };
    aboutOverlay.addEventListener('animationend', done, { once: true });
    setTimeout(done, 300); // 动画事件缺失时的兜底
  }
  $('about-toggle').addEventListener('click', openAbout);
  $('about-close').addEventListener('click', closeAbout);
  aboutOverlay.addEventListener('click', (e) => {
    if (e.target === aboutOverlay) closeAbout();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !aboutOverlay.hidden) closeAbout();
  });

  $('lang-toggle').addEventListener('click', () => {
    setLang(I18N.lang === 'zh' ? 'en' : 'zh');
    localStorage.setItem(LANG_KEY, I18N.lang);
    applyStaticLang(); // 会同步 html.lang，按钮字形随之切换
    makeWatermark();
    render(null); // 重建标注/标签轴/读数以套用新语言（保留当前缩放）
  });

  scaleButtons.forEach((btn) => btn.addEventListener('click', () => {
    const useLog = btn.dataset.scale === 'log';
    if (useLog === logOn) return;
    logOn = useLog;
    setLogScale(chart, logOn);
    scaleButtons.forEach((b) => b.classList.toggle('active', b === btn));
    localStorage.setItem(SCALE_KEY, logOn ? 'log' : 'linear');
  }));

  // 两个标注开关共用一套「全卸再按开关重挂」流程
  function applyAnnotations() {
    for (const p of attached) attachedHost.detachPrimitive(p);
    attached = currentMainPrims();
    for (const p of attached) attachedHost.attachPrimitive(p);
    for (const p of attachedPhase) phaseSolid.detachPrimitive(p);
    attachedPhase = phaseOn ? currentPhasePrims() : [];
    for (const p of attachedPhase) phaseSolid.attachPrimitive(p);
  }

  $('halving-toggle').addEventListener('click', () => {
    halvingOn = !halvingOn;
    applyAnnotations();
    $('halving-toggle').classList.toggle('active', halvingOn);
    localStorage.setItem(ANNOT_HALVING_KEY, halvingOn ? '1' : '0');
  });

  $('bands-toggle').addEventListener('click', () => {
    bandsOn = !bandsOn;
    applyAnnotations();
    $('bands-toggle').classList.toggle('active', bandsOn);
    localStorage.setItem(ANNOT_BANDS_KEY, bandsOn ? '1' : '0');
  });

  $('theme-toggle').addEventListener('click', () => {
    themeName = themeName === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, themeName);
    setTheme(themeName);
    document.documentElement.dataset.theme = themeName;
    applyChartTheme(chart, series, lineSeries, phaseSolid, phaseDashed);
    makeWatermark();
    render(null); // 重建标注/标签轴以套用新配色（保留当前缩放）
  });

  // ── 数据：快照与高度锚点立即渲染，链上高度与实时尾部各自后台升级 ──
  let snapshot;
  try {
    [snapshot] = await Promise.all([loadSnapshot(), loadHeightAnchors()]);
  } catch (e) {
    console.error(e);
    $('loading-text').textContent = t('loadFailData', e.message);
    return;
  }
  render(snapshot, { fit: true });
  makeWatermark();
  $('loading').hidden = true;

  // ── 链路健康与指示灯 ──
  // 三个指示灯：价格看价格链路；区块高度与狼波指数看高度链路（指数是高度的
  // 纯函数）。中断时指示灯熄灭、高度读数加「≈」、弹一次提示；恢复即收起
  function updateLinkUI() {
    const hCell = $('stat-height-cell');
    const pCell = $('stat-price-cell');
    const wCell = $('stat-wave-cell');
    hCell.querySelector('.live-dot').classList.toggle('off', link.heightStale);
    wCell.querySelector('.live-dot').classList.toggle('off', link.heightStale);
    pCell.querySelector('.live-dot').classList.toggle('off', link.priceStale);
    hCell.title = t(link.heightStale ? 'titleHeightStale' : 'titleHeightLive');
    pCell.title = t(link.priceStale ? 'titlePriceStale' : 'titlePriceLive');
  }
  function checkLinks() {
    const now = Date.now();
    const hStale = now - link.heightAt > HEIGHT_STALE_MS;
    if (hStale && link.heightTried && !link.heightNoticed) {
      showNotice(t('noticeHeightDown'), 'height');
      link.heightNoticed = true;
    } else if (!hStale && link.heightNoticed) {
      hideNotice('height');
      link.heightNoticed = false;
    }
    if (hStale !== link.heightStale) {
      link.heightStale = hStale;
      if (meta) updateStats(); // 「≈」前缀随状态切换
    }
    link.priceStale = now - link.priceAt > PRICE_STALE_MS;
    // 价格 WS 连着却 90s 没有任何消息 = 假死（半开连接）：主动断开让它重连，
    // 期间 ticker 轮询接管（WS 自己不会报错，不这样做会一直显示旧价）
    if (link.priceStale && wsAlive && priceSock) {
      try { priceSock.close(); } catch { /* 已关闭 */ }
    }
    updateLinkUI();
  }
  function markHeightLive() {
    link.heightAt = Date.now();
    link.heightTried = true;
    if (link.heightStale) checkLinks(); // 恢复瞬间立即点亮，不等 5s 巡检
  }

  // 新高度统一入口：HTTP 轮询与 WS 推送都走这里。更低的高度忽略——
  // 推送与轮询偶有先后之差，真实链高只会前进
  function applyTipHeight(tip) {
    if (!Number.isFinite(tip)) return;
    markHeightLive();
    if (tipHeight !== null && tip <= tipHeight) return;
    tipHeight = tip;
    setTipAnchor(tip);
    render(null); // 视图不动，引导线/读数/指数尾部原地前移
  }

  // ── 链上高度：mempool.space WebSocket 推送新块，出块即刻刷新 ──
  // 连上后 want blocks：服务端先回最近区块列表（blocks），之后每个新块推
  // 一条 { block }；30s 一次 ping，5s 内没有任何消息视为假死主动断开；
  // 断线期间立刻回到 60s HTTP 轮询，并按退避重连（连不上时 2s → 128s，再加等量随机抖动）
  const MEMPOOL_WS = 'wss://mempool.space/api/v1/ws';
  let heightWsAlive = false;
  let heightSock = null;
  let heightReconnectTimer = null;
  let heightWsFails = 0; // 连续「一条消息都没收到就断开」的次数（退避用）
  function connectHeightStream() {
    clearTimeout(heightReconnectTimer);
    heightReconnectTimer = null;
    if (heightSock && heightSock.readyState <= WebSocket.OPEN) return; // 连接中 / 已连接
    let sock;
    try {
      sock = new WebSocket(MEMPOOL_WS);
    } catch {
      return; // 环境不支持时永久走轮询兜底
    }
    heightSock = sock;
    let gotMessage = false;
    let pingTimer = null;
    let pongTimer = null;
    sock.onopen = () => {
      heightWsAlive = true;
      sock.send(JSON.stringify({ action: 'want', data: ['blocks'] }));
      pingTimer = setInterval(() => {
        if (sock.readyState !== WebSocket.OPEN) return;
        sock.send(JSON.stringify({ action: 'ping' }));
        clearTimeout(pongTimer);
        pongTimer = setTimeout(() => sock.close(), 5000);
      }, 30000);
    };
    sock.onmessage = (ev) => {
      clearTimeout(pongTimer);
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return; // 忽略坏消息
      }
      gotMessage = true;
      heightWsFails = 0;
      markHeightLive(); // 任何消息（含 pong）都证明链路在线
      const h = msg.block?.height
        ?? (Array.isArray(msg.blocks) && msg.blocks.length
          ? Math.max(...msg.blocks.map((b) => b.height))
          : null);
      if (h != null) applyTipHeight(Number(h));
    };
    sock.onclose = () => {
      clearInterval(pingTimer);
      clearTimeout(pongTimer);
      heightWsAlive = false;
      if (heightSock === sock) heightSock = null;
      if (!gotMessage) heightWsFails = Math.min(heightWsFails + 1, 6);
      pollHeight(); // 断线期间立刻回到 HTTP 轮询
      const base = 2000 * 2 ** heightWsFails; // 2s, 4s … 128s
      heightReconnectTimer = setTimeout(connectHeightStream, base + Math.random() * base);
    };
    sock.onerror = () => {
      try { sock.close(); } catch { /* 已关闭 */ }
    };
  }

  // HTTP 轮询兜底：WS 在线时跳过（force = 切回前台 / 网络恢复时强制补拉一次）
  let heightPollBusy = false;
  async function pollHeight(force = false) {
    if ((heightWsAlive && !force) || heightPollBusy) return;
    heightPollBusy = true;
    try {
      applyTipHeight(await fetchTipHeight());
    } catch {
      link.heightTried = true;
      if (tipHeight === null) render(null); // 推算值随时间前移
    } finally {
      heightPollBusy = false;
      checkLinks();
    }
  }
  pollHeight();
  connectHeightStream();
  setInterval(pollHeight, 60000);
  setInterval(checkLinks, 5000);

  // ── 价格尾部：Bitstamp 分页补到今天，失败回退 Coinbase，再失败提示快照截止日 ──
  // 不与链上高度捆绑等待：高度链路不受价格源快慢的影响
  const sinceTs = snapshot.at(-1).time;
  let liveTail = [];
  try {
    try {
      liveTail = await fetchBitstampLive(sinceTs);
    } catch (e1) {
      console.warn('Bitstamp 实时数据失败，尝试 Coinbase：', e1);
      liveTail = await fetchCoinbaseFallback(sinceTs);
    }
  } catch (e2) {
    console.warn('Coinbase 备用源也失败：', e2);
  }
  if (liveTail.length) {
    render(mergeCandles(snapshot, liveTail));
  } else {
    showNotice(t('noticeStale', fmtYMD(sinceTs)), 'stale');
  }

  // ── 价格实时流 ──
  // 价格走 Bitstamp WebSocket 逐笔成交（肉眼可见的连续跳动）：
  // 顶栏读数逐笔即时更新；图表重绘节流到最多 2s 一次（每笔成交都
  // 全量重绘太重）。WS 断线 5s 后自动重连，期间 30s ticker 轮询兜底。
  // K 线尾部 5 分钟重取一次（跨 UTC 零点时长出新的一根日线）
  let chartRenderQueued = false;
  let statsFlushTimer = null;
  function applyLivePrice(p) {
    if (!Number.isFinite(p)) return;
    link.priceAt = Date.now();
    if (link.priceStale) checkLinks(); // 恢复瞬间立即点亮
    if (p === livePrice) return;
    livePrice = p;
    const lastC = dailyReal.at(-1);
    if (lastC) {
      // daily 与 dailyReal 共享对象引用，改这里即改数据源
      lastC.close = p;
      if (p > lastC.high) lastC.high = p;
      if (p < lastC.low) lastC.low = p;
    }
    // 顶栏刷新 250ms 合并：盘口流一秒可达多条，逐条刷 DOM 没有意义
    if (!statsFlushTimer) {
      statsFlushTimer = setTimeout(() => {
        statsFlushTimer = null;
        updateStats();
      }, 250);
    }
    if (lastC && !chartRenderQueued) {
      chartRenderQueued = true;
      setTimeout(() => {
        chartRenderQueued = false;
        render(null); // 视图不动，K 线尾部/价格牌/引导线原地刷新
      }, 2000);
    }
  }

  function connectPriceStream() {
    clearTimeout(priceReconnectTimer);
    priceReconnectTimer = null;
    if (priceSock && priceSock.readyState <= WebSocket.OPEN) return; // 连接中 / 已连接
    let sock;
    try {
      sock = new WebSocket('wss://ws.bitstamp.net');
    } catch {
      return; // 环境不支持时永久走轮询兜底
    }
    priceSock = sock;
    sock.onopen = () => {
      wsAlive = true;
      // 逐笔成交 = 真实成交价；盘口 = 买一/卖一每秒多次变动，
      // 用中间价填充成交之间的空隙，价格秒级连续跳动
      sock.send(JSON.stringify({ event: 'bts:subscribe', data: { channel: 'live_trades_btcusd' } }));
      sock.send(JSON.stringify({ event: 'bts:subscribe', data: { channel: 'order_book_btcusd' } }));
    };
    sock.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === 'bts:request_reconnect') {
          sock.close(); // Bitstamp 要求客户端重连（onclose 会安排重连）
        } else if (msg.event === 'trade' && msg.data?.price) {
          applyLivePrice(Number(msg.data.price));
        } else if (msg.event === 'data' && msg.channel === 'order_book_btcusd') {
          const bid = Number(msg.data?.bids?.[0]?.[0]);
          const ask = Number(msg.data?.asks?.[0]?.[0]);
          if (Number.isFinite(bid) && Number.isFinite(ask)) {
            applyLivePrice((bid + ask) / 2);
          }
        }
      } catch { /* 忽略坏消息 */ }
    };
    sock.onclose = () => {
      wsAlive = false;
      if (priceSock === sock) priceSock = null;
      priceReconnectTimer = setTimeout(connectPriceStream, 5000);
    };
    sock.onerror = () => {
      try { sock.close(); } catch { /* 已关闭 */ }
    };
  }

  async function pollPrice(force = false) {
    if (wsAlive && !force) return; // WS 在线时无需轮询
    try {
      const res = await fetch('https://www.bitstamp.net/api/v2/ticker/btcusd/', {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return;
      applyLivePrice(parseFloat((await res.json()).last));
    } catch { /* 单次失败静默，下一轮再试 */ }
  }
  let candleRefreshBusy = false;
  async function pollCandles() {
    if (candleRefreshBusy || !dailyReal.length) return;
    candleRefreshBusy = true;
    try {
      const tail = await fetchBitstampLive(dailyReal.at(-1).time - DAY);
      if (tail.length) render(mergeCandles(daily, tail));
    } catch { /* 单次失败静默，下一轮再试 */ } finally {
      candleRefreshBusy = false;
    }
  }
  setInterval(pollPrice, 30000);
  setInterval(pollCandles, 300000);
  pollPrice();
  connectPriceStream();

  // ── 切回前台 / 网络恢复：立即补拉并重连，不等下一个轮询周期 ──
  // 后台标签页的定时器会被节流甚至冻结（iOS Safari 还会掐断 WebSocket），
  // 回来时先把该连的连上、该拉的拉一次，再刷新指示灯
  function refreshNow() {
    connectHeightStream();
    connectPriceStream();
    pollHeight(true);
    pollPrice(true);
    pollCandles();
    checkLinks();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshNow();
  });
  window.addEventListener('online', refreshNow);
  console.table(pivots.map((p) => ({ 类型: p.type === 'top' ? '牛顶' : '熊底', 日期: fmtDate(p.time), 价格: p.price, 高度: heightAt(p.time) })));
}

init().catch((e) => {
  console.error(e);
  $('loading-text').textContent = t('loadFailInit', e.message);
});
