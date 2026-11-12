// src/components/visualizer/skyline/spriteCache.ts
// 词云用的预渲染模糊文字贴图（每个词 × 每个模糊档位），LRU 淘汰。

/**
 * 预渲染的文字贴图：每个词 × 每个模糊档位一张离屏图，LRU 淘汰。
 *
 * - 模糊用 shadowBlur 实现（把文字画到画布外，只让阴影落进来），Safari 也支持；
 * - 贴图统一画成白色，颜色在绘制时整体着色，换主题色不需要重画；
 * - 模糊档位用半分辨率（反正是糊的），生成和上传显卡都便宜 4 倍；
 * - 生成后转成 ImageBitmap，绘制时不再需要上传；
 * - warm() 供空闲时提前生成，避免换句那一帧现场生成造成掉帧。
 */
export interface Sprite {
    canvas: HTMLCanvasElement;
    /** 转换完成后优先用它绘制 */
    bitmap?: ImageBitmap;
    /** 文字左边缘在贴图中的 x（px），即模糊留白 */
    padX: number;
    /** 文字竖直中心在贴图中的 y（px） */
    midY: number;
    /** 参考字号（px），绘制时按 目标字号 / ref 缩放 */
    ref: number;
}

/** 取画布的 2D 上下文；浏览器不给时抛错 */
export const get2dContext = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('[skyline] 无法创建 2D 画布上下文');
    return ctx;
};

export const REF_SIZE = 128;
/** 各档位的模糊半径（以 REF_SIZE 字号计） */
export const BLUR_LEVELS = [0, 2, 4, 6.5, 9.5];

export class SpriteCache {
    private readonly map = new Map<string, (Sprite | undefined)[]>();
    private readonly measureCtx: CanvasRenderingContext2D;
    /** 统计：现场生成（未提前准备）的次数 */
    misses = 0;

    /**
     * @param font 默认字体栈
     * @param fontJa 含假名的词用的字体栈（日文字形优先）
     */
    /**
     * @param weight 字重（与主歌词一致，由 resolveThemeFontWeight 决定）
     */
    constructor(
        private readonly font: string,
        private readonly fontJa: string = font,
        private readonly weight = 700,
        private readonly limit = 400,
    ) {
        this.measureCtx = get2dContext(document.createElement('canvas'));
        this.applyFont(this.measureCtx, REF_SIZE, '');
    }

    private fontFor(text: string): string {
        return /[\u3040-\u30ff]/.test(text) ? this.fontJa : this.font;
    }

    clear(): void {
        for (const levels of this.map.values()) for (const s of levels) s?.bitmap?.close();
        this.map.clear();
        this.applyFont(this.measureCtx, REF_SIZE, ''); // 字体加载完成后重新测量
    }

    /** 文字宽度 / 字号 */
    measure(text: string): number {
        this.applyFont(this.measureCtx, REF_SIZE, text);
        return this.measureCtx.measureText(text).width / REF_SIZE;
    }

    has(text: string, level: number): boolean {
        return !!this.map.get(text)?.[level];
    }

    get(text: string, level: number): Sprite {
        const levels = this.touch(text);
        let s = levels[level];
        if (!s) {
            this.misses++;
            s = levels[level] = this.render(text, level);
        }
        return s;
    }

    /** 提前生成（不影响 LRU 顺序之外的东西） */
    warm(text: string, level: number): void {
        const levels = this.touch(text);
        levels[level] ??= this.render(text, level);
    }

    private touch(text: string): (Sprite | undefined)[] {
        let levels = this.map.get(text);
        if (levels) {
            this.map.delete(text);
            this.map.set(text, levels);
            return levels;
        }
        levels = [];
        this.map.set(text, levels);
        if (this.map.size > this.limit) {
            const oldest = this.map.keys().next();
            if (!oldest.done) {
                for (const s of this.map.get(oldest.value) ?? []) s?.bitmap?.close();
                this.map.delete(oldest.value);
            }
        }
        return levels;
    }

    private render(text: string, level: number): Sprite {
        // 清晰档用全分辨率，模糊档用半分辨率
        const ref = level === 0 ? REF_SIZE : REF_SIZE / 2;
        const k = ref / REF_SIZE;
        const blur = BLUR_LEVELS[level] * k;
        const w = this.measure(text) * REF_SIZE * k;
        const pad = Math.ceil(blur * 2.6) + 3;
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(w + pad * 2);
        canvas.height = Math.ceil(ref * 1.35) + pad * 2;
        const ctx = get2dContext(canvas);
        this.applyFont(ctx, ref, text);
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        const midY = canvas.height / 2;
        if (blur <= 0) {
            ctx.fillText(text, pad, midY);
        } else {
            const off = canvas.width + 1000;
            ctx.shadowColor = '#fff';
            ctx.shadowBlur = blur * 2; // shadowBlur ≈ 2σ
            ctx.shadowOffsetX = off;
            ctx.fillText(text, pad - off, midY);
        }
        const sprite: Sprite = { canvas, padX: pad, midY, ref };
        if (typeof createImageBitmap === 'function') {
            createImageBitmap(canvas)
                .then((bmp) => (sprite.bitmap = bmp))
                .catch(() => {});
        }
        return sprite;
    }

    private applyFont(ctx: CanvasRenderingContext2D, size: number, text: string): void {
        const font = `${this.weight} ${size}px ${this.fontFor(text)}`;
        if (ctx.font === font && ctx === this.measureCtx) return;
        ctx.font = font;
        const c = ctx as CanvasRenderingContext2D & { fontStretch?: string; letterSpacing?: string };
        if ('fontStretch' in c) c.fontStretch = 'extra-condensed';
        if ('letterSpacing' in c) c.letterSpacing = `${(size * 0.05).toFixed(1)}px`;
    }
}
