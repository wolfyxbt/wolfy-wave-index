// 往期同位回声：十字线悬停在某个周期位置时，在之前每一轮周期的同一位置
//（高度 − n × 210,000）同步给出视觉提示——贯穿面板的竖直点线 + 落在
// 数据线上的圆环；主图圆环旁再挂一枚该处价格的标签胶囊。
// 主图与副图各挂一个实例，由 main.js 在十字线回调里喂同一组标记。
// 全部画在 'top' 层：该层与十字线同在顶层画布，随光标移动重绘，
// 不触发整图重绘（悬停是高频事件）。
import { Primitive, drawTag } from './base.js';
import { COLORS } from '../config.js';

export class CycleEcho extends Primitive {
  // mode 'price'：圆环落在价格线上（mark.price）并挂价格标签；
  // mode 'wave'：圆环落在狼波指数线上（mark.wave）
  constructor({ mode }) {
    super('top');
    this._mode = mode;
    this._marks = [];
  }

  // marks: [{ time, price, wave, color, label }]
  //   time  = 该轮周期同位 K 线桶的起始高度
  //   price = 该桶收盘价（无行情的更早历史为 null：只画竖线）
  //   wave  = 该处狼波指数；color = 圆环颜色；label = 价格标签文字
  setMarks(marks) {
    this._marks = marks;
  }

  _draw(ctx, media) {
    for (const m of this._marks) {
      const x = this.timeToX(m.time);
      if (x === null || x < -8 || x > media.width + 8) continue;
      ctx.save();
      ctx.strokeStyle = COLORS.crosshairLine;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]); // 比十字线更疏的点线：一眼区分「本体」与「回声」
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, media.height);
      ctx.stroke();
      ctx.restore();

      const value = this._mode === 'wave' ? m.wave : m.price;
      const y = value == null ? null : this.priceToY(value);
      if (y === null || y < -8 || y > media.height + 8) continue;
      // 空心圆环：同位处的狼波色与线本身同色，实心点会融进线里
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.chartBg;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = m.color;
      ctx.stroke();

      if (this._mode !== 'price' || !m.label) continue;
      // 价格标签默认悬在圆环上方，贴近面板顶边时翻到下方
      const above = y - 32 >= 4;
      drawTag(ctx, x, above ? y - 32 : y + 12, m.label, {
        bg: COLORS.tagBg,
        color: COLORS.echoLabel,
        anchor: 'tc',
        maxX: media.width,
      });
    }
  }
}
