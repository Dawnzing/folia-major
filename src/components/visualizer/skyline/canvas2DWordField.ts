import { resolveLyricPixelRatio } from '../../../utils/lyricRenderQuality';
import type { LyricRenderScale } from '../../../types';
import type { SkyDoc as LyricDoc } from './skylineLyrics';
import { BLUR_LEVELS, get2dContext, SpriteCache, type Sprite } from './spriteCache';
import { WordTunnel, type StageLayout } from './wordTunnel';

// src/components/visualizer/skyline/canvas2DWordField.ts
// 两侧词云的 Canvas 2D 渲染：贴图提前生成、只清除和着色画过的区域、模糊档位交叉淡化。

const MAX_LEVEL = BLUR_LEVELS.length - 1;
/** 每帧用于提前生成贴图的时间预算（ms），165Hz 屏幕一帧只有 6ms */
const WARM_BUDGET_MS = 1.2;

type Box = [number, number, number, number];
/** 叠加在词云之上的图层（如粒子），返回本帧画过的区域 */
export type Overlay = (ctx: CanvasRenderingContext2D, dpr: number) => Box | null;

/**
 * 两侧词云的 Canvas 2D 渲染：运动由 WordTunnel 计算，这里只负责画。
 * 性能要点：贴图提前生成；只清除和着色有内容的区域；模糊在相邻档位间交叉淡化。
 */
export class Canvas2DWordField {
    readonly tunnel: WordTunnel;
    private readonly ctx: CanvasRenderingContext2D;
    private cache: SpriteCache;
    private dpr = 1;
    /** 全局歌词分辨率挡位（「动画与性能」），叠在样式自己的默认像素密度上 */
    private renderScale: LyricRenderScale = 1;
    private layout: StageLayout | null = null;
    private prevBox: Box | null = null;
    private warmQueue: string[] = [];
    private warmCursor = 0;
    private lastWarmScan = -Infinity;
    /** 上一次性真正画过的时间；暂停且时间、颜色、布局都没变时用它跳过整帧重绘 */
    private lastPainted = Number.NaN;
    /** 需要重画的理由：歌词、布局、字体、颜色、tuning 变了 */
    private dirty = true;
    /** 叠加图层：画在着色之后，不受词云主题色影响 */
    readonly overlays: Overlay[] = [];

    /**
     * @param font 字体栈（与主歌词一致，由宿主的主题字体决定）
     * @param fontJa 含假名的词用的字体栈
     * @param weight 字重（与主歌词一致）
     */
    constructor(
        private readonly canvas: HTMLCanvasElement,
        private color: string,
        font: string,
        fontJa: string = font,
        weight = 700,
    ) {
        this.ctx = get2dContext(canvas);
        this.cache = new SpriteCache(font, fontJa, weight);
        this.tunnel = new WordTunnel((text) => this.cache.measure(text));

        // 字体加载完成后清空贴图缓存（之前画的可能是回退字体）
        void document.fonts.ready.then(() => this.refreshFonts());
    }

    /** 换字体（主题字体变了）：重建贴图缓存并重新摆放 */
    setFont(font: string, fontJa: string = font, weight = 700): void {
        this.cache.clear();
        this.cache = new SpriteCache(font, fontJa, weight);
        this.lastWarmScan = -Infinity;
        this.invalidate();
    }

    /** 全局分辨率挡位变了：重设画布像素尺寸并重画 */
    setRenderScale(scale: LyricRenderScale): void {
        if (scale === this.renderScale) return;
        this.renderScale = scale;
        if (this.layout) this.resize(this.layout);
        this.dirty = true;
    }

    /** 字体加载完成后：清空贴图缓存（之前画的可能是回退字体）并重新摆放 */
    refreshFonts(): void {
        this.cache.clear();
        this.lastWarmScan = -Infinity;
        this.invalidate();
    }

    /** 重摆两侧词并重画（参数、字体宽度、布局失效时调用） */
    invalidate(): void {
        this.tunnel.invalidate();
        this.dirty = true;
    }

    setDoc(doc: LyricDoc): void {
        this.tunnel.setLines(doc.lines);
        this.lastWarmScan = -Infinity;
        this.dirty = true;
    }

    setLayout(layout: StageLayout): void {
        this.layout = layout;
        this.resize(layout);
        this.tunnel.setLayout(layout);
        this.dirty = true;
    }

    /** 按布局和分辨率挡位重设画布像素尺寸（尺寸没变就不动） */
    private resize(layout: StageLayout): void {
        this.dpr = resolveLyricPixelRatio(Math.min(window.devicePixelRatio || 1, 2), this.renderScale);
        const w = Math.round(layout.w * this.dpr);
        const h = Math.round(layout.h * this.dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
            this.prevBox = null;
        }
    }

    /** 只改着色，不重画贴图，可以每帧调用（主题色渐变） */
    setColor(color: string): void {
        if (color === this.color) return;
        this.color = color;
        this.dirty = true;
    }

    /**
     * 推进一帧：播放中或歌词时间变了、或有失效（布局、字体、颜色）才重画；
     * 暂停在同一句里且上一次已经画完时只继续预热贴图，不再整帧清屏、贴图、着色。
     */
    update(t: number, playing: boolean): void {
        if (this.dirty || playing || t !== this.lastPainted) {
            this.tunnel.update(t);
            this.draw();
            this.lastPainted = t;
            this.dirty = false;
        }
        this.warm(t);
    }

    dispose(): void {
        this.cache.clear();
    }

    /** 在时间预算内，为接下来要出现的词提前生成所有模糊档位 */
    private warm(t: number): void {
        // 每 0.25 秒（或跳转后）刷新一次待生成列表
        if (Math.abs(t - this.lastWarmScan) > 0.25) {
            this.warmQueue = this.tunnel.upcoming(t, 2);
            this.warmCursor = 0;
            this.lastWarmScan = t;
        }
        const start = performance.now();
        while (this.warmCursor < this.warmQueue.length) {
            const text = this.warmQueue[this.warmCursor];
            let done = true;
            for (let l = 0; l <= MAX_LEVEL; l++) {
                if (this.cache.has(text, l)) continue;
                this.cache.warm(text, l);
                if (performance.now() - start > WARM_BUDGET_MS) {
                    done = false;
                    break;
                }
            }
            if (!done) return;
            this.warmCursor++;
        }
    }

    private draw(): void {
        const { ctx, dpr } = this;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // 只清除上一帧画过的区域
        if (this.prevBox) {
            const [x0, y0, x1, y1] = this.prevBox;
            ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
        }
        const words = this.tunnel.out;
        if (!words.length) {
            this.prevBox = this.drawOverlays(null);
            return;
        }

        let bx0 = Infinity;
        let by0 = Infinity;
        let bx1 = -Infinity;
        let by1 = -Infinity;
        ctx.globalCompositeOperation = 'lighter';

        const blit = (sp: Sprite, w: (typeof words)[number], alpha: number) => {
            if (alpha < 0.004) return;
            const scale = (w.size * dpr) / sp.ref;
            const cw = sp.canvas.width * scale;
            const ch = sp.canvas.height * scale;
            const textW = (sp.canvas.width - sp.padX * 2) * scale;
            const x = w.x * dpr;
            const y = w.y * dpr;
            let dx: number;
            let dy: number;
            switch (w.side) {
                case 'right': // 文字从锚点向右延伸
                    dx = x - sp.padX * scale;
                    dy = y - sp.midY * scale;
                    break;
                case 'left': // 文字从锚点向左延伸
                    dx = x - textW - sp.padX * scale;
                    dy = y - sp.midY * scale;
                    break;
                case 'down': // 锚点在文字上沿
                    dx = x - cw / 2;
                    dy = y + (w.size * dpr) / 2 - sp.midY * scale;
                    break;
                case 'up': // 锚点在文字下沿
                    dx = x - cw / 2;
                    dy = y - (w.size * dpr) / 2 - sp.midY * scale;
            }
            ctx.globalAlpha = alpha;
            ctx.drawImage(sp.bitmap ?? sp.canvas, dx, dy, cw, ch);
            if (dx < bx0) bx0 = dx;
            if (dy < by0) by0 = dy;
            if (dx + cw > bx1) bx1 = dx + cw;
            if (dy + ch > by1) by1 = dy + ch;
        };

        for (const w of words) {
            // 在相邻两个模糊档位之间交叉淡化，避免模糊程度跳变
            const b = Math.min(MAX_LEVEL, Math.max(0, w.blur));
            const l0 = Math.floor(b);
            const f = b - l0;
            blit(this.cache.get(w.text, l0), w, w.alpha * (1 - f));
            if (f > 0.004 && l0 < MAX_LEVEL) blit(this.cache.get(w.text, l0 + 1), w, w.alpha * f);
        }

        if (bx1 <= bx0) {
            this.prevBox = this.drawOverlays(null);
            return;
        }
        // 只给有内容的区域着色：白色文字层 → 主题色（保留透明度）
        const box: Box = [
            Math.max(0, Math.floor(bx0) - 2),
            Math.max(0, Math.floor(by0) - 2),
            Math.min(this.canvas.width, Math.ceil(bx1) + 2),
            Math.min(this.canvas.height, Math.ceil(by1) + 2),
        ];
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = this.color;
        ctx.fillRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
        ctx.globalCompositeOperation = 'source-over';
        this.prevBox = this.drawOverlays(box);
    }

    /** 画叠加图层，并把它们的区域并入本帧的脏区 */
    private drawOverlays(box: Box | null): Box | null {
        for (const draw of this.overlays) {
            const b = draw(this.ctx, this.dpr);
            if (!b) continue;
            box = box
                ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])]
                : b;
        }
        return box;
    }
}
