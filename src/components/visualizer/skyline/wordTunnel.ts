import { EASINGS, type EasingName } from './easing';
import { lineIndexAt, type SkyLine as LyricLine } from './skylineLyrics';
import { buildWordPool } from './words';

// src/components/visualizer/skyline/wordTunnel.ts
// 两侧词云的运动模型："按句推进的镜头"，画面只由播放时间决定。

/**
 * 两侧词云的运动模型："按句推进的镜头"。
 *
 * - 每个词在空间里的位置（深度 Z、平面坐标）在载入歌词时用固定种子一次性摆好；
 * - 镜头位置只由播放时间决定，每一句（一轮）共前进 stepZ：
 *   一部分在换句时沿缓动曲线推进，其余部分在句内按"这句唱到哪了"匀速前进，
 *   所以两句之间文字是渐渐放大的，换句时再推一下（与原视频实测一致）；
 * - 所以拖动进度条、暂停、重播，画面都与时间严格对应。
 *
 * 屏幕布局：宽屏时词在主歌词左右两侧，各自以靠近主歌词的那一侧为透视中心向外扩散；
 * 竖屏时词在主歌词上下方。
 */
export interface TunnelParams {
    /** 每句推进的距离 */
    stepZ: number;
    /** 新词出现时离镜头的距离 */
    spawnDist: number;
    /** 词消失时离镜头的距离 */
    nearDist: number;
    /** 焦平面：在这个距离上最清晰，字号 = baseSize */
    focusDist: number;
    /** 远处淡入的距离范围 */
    fadeIn: number;
    /** 近处淡出的距离范围 */
    fadeOut: number;
    /** 推进动画时长（秒），主歌词换句也用这个 */
    duration: number;
    easing: EasingName;
    /** 每一轮里句内匀速前进所占的比例（其余在换句时推进）。原视频约一半 */
    driftShare: number;
    /** 每句每侧放几个词（最少、最多） */
    perSide: [number, number];
    /** 焦平面上的字号（相对主歌词字号） */
    baseSize: number;
    sizeJitter: [number, number];
    /** 词云与主歌词之间的间距（相对主歌词字号） */
    gap: number;
    /** 宽屏：竖直分散范围（焦平面上，占窗口高度的比例） */
    spread: number;
    /** 词在可用区域里分布的范围（0～1） */
    zoneFill: number;
    /** 离焦 → 模糊档位的倍率 */
    blurStrength: number;
    /** 运动模糊：推进越快、离得越近越糊，让快速位移看起来顺滑 */
    motionBlur: number;
    /** 远处最暗时的亮度 */
    farDim: number;
    /** 窗口边缘淡出宽度（占短边的比例） */
    edgeFade: number;
}

export const defaultTunnelParams: TunnelParams = {
    stepZ: 1,
    spawnDist: 6,
    nearDist: 1.3,
    focusDist: 3,
    fadeIn: 0.9,
    fadeOut: 1.0,
    duration: 0.75,
    easing: 'smooth',
    driftShare: 0.5,
    perSide: [2, 3],
    baseSize: 0.85,
    sizeJitter: [0.7, 1.25],
    gap: 0.7,
    spread: 0.14,
    zoneFill: 0.82,
    blurStrength: 6,
    motionBlur: 0.22,
    farDim: 0.35,
    edgeFade: 0.06,
};

export interface StageLayout {
    w: number;
    h: number;
    /** 主歌词字号（px） */
    em: number;
    /** 主歌词中心 y（px） */
    centerY: number;
    /** 主歌词最大半宽（px） */
    mainHalfW: number;
    /** 左右两侧留出的安全边宽度（px）：预览把 16:9 裁进 16:10，贴边的远处词会被裁掉一半 */
    edgeMargin: number;
    portrait: boolean;
}

type Side = 'left' | 'right' | 'up' | 'down';

interface TunnelWord {
    text: string;
    side: Side;
    /** 焦平面上，相对本侧透视中心的偏移（px）：
     *  左右侧时 ax 为向外距离、ay 为竖直偏移；上下侧时 ax 为水平偏移、ay 为向外距离 */
    ax: number;
    ay: number;
    /** 焦平面字号（px） */
    size: number;
    bright: number;
    /** 文字宽度 / 字号 */
    ratio: number;
}

interface Layer {
    z: number;
    words: TunnelWord[];
}

/** 每帧输出给渲染层 */
export interface RenderWord {
    text: string;
    /** 锚点（px）：靠近主歌词那一侧的文字边缘中点 */
    x: number;
    y: number;
    side: Side;
    size: number;
    alpha: number;
    blur: number;
    depth: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => {
    v = clamp01(v);
    return v * v * (3 - 2 * v);
};

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hashString(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
}

export class WordTunnel {
    params: TunnelParams = structuredClone(defaultTunnelParams);
    /** 主歌词提前换句的秒数（与 CenterLyrics.lead 一致） */
    lead = 0.25;
    readonly out: RenderWord[] = [];

    private lines: LyricLine[] = [];
    private pool: string[][] = [];
    private seed = 1;
    private layout: StageLayout | null = null;
    /** 每句的换句开始时间、换句推进时长、这一轮结束时间（下一句换句开始） */
    private T: number[] = [];
    private D: number[] = [];
    private N: number[] = [];
    private T0 = 0;
    private layers: Layer[] = [];
    private dirty = true;

    constructor(private readonly measure: (text: string) => number) {}

    setLines(lines: LyricLine[]): void {
        this.lines = lines;
        this.pool = buildWordPool(lines);
        this.seed = hashString(lines.map((l) => l.text).join('\n'));
        this.dirty = true;
    }

    setLayout(layout: StageLayout): void {
        const prev = this.layout;
        this.layout = layout;
        if (
            !prev
            || prev.w !== layout.w
            || prev.h !== layout.h
            || prev.em !== layout.em
            || prev.mainHalfW !== layout.mainHalfW
            || prev.edgeMargin !== layout.edgeMargin
        ) {
            this.dirty = true;
        }
    }

    /** 参数改动后调用（会重新摆放所有词） */
    invalidate(): void {
        this.dirty = true;
    }

    /** 字体加载完成后宽度会变，重新测量 */
    remeasure(): void {
        for (const l of this.layers) for (const w of l.words) w.ratio = this.measure(w.text);
    }

    // ---------- 时间线 ----------

    private buildTimeline(): void {
        const p = this.params;
        this.T = this.lines.map((l) => l.start - this.lead);
        this.T0 = Math.min(0, this.T[0] ?? 0);
        this.N = this.T.map((t, k) => this.T[k + 1] ?? Math.max(t + p.duration + 0.5, this.lines[k].end + 2));
        this.D = this.T.map((t, k) => Math.max(0.05, Math.min(p.duration, (this.N[k] - t) * 0.9)));
    }

    /**
     * 镜头位置。第 k 句这一轮共前进 stepZ：
     * 换句时沿缓动曲线推进 (1 - driftShare)·stepZ，句内按进度匀速前进 driftShare·stepZ，首尾连续。
     */
    cameraAt(t: number): number {
        const p = this.params;
        const share = clamp01(p.driftShare);
        const k = lineIndexAt(this.lines, t + this.lead);
        if (k < 0) {
            // 片头：从 0 匀速前进到第一句换句时的位置
            const first = this.T.at(0);
            const prog = first === undefined || first <= this.T0 ? 1 : clamp01((t - this.T0) / (first - this.T0));
            return share * p.stepZ * prog;
        }
        const ease = EASINGS[p.easing].fn;
        const u = clamp01((t - this.T[k]) / this.D[k]);
        const prog = clamp01((t - this.T[k]) / (this.N[k] - this.T[k]));
        return (k + 1) * p.stepZ - (1 - share) * p.stepZ * (1 - ease(u)) + share * p.stepZ * prog;
    }

    // ---------- 摆放 ----------

    private build(): void {
        const L = this.layout;
        if (!L) return;
        this.buildTimeline();
        const p = this.params;
        this.layers = [];

        // 片头：预先放几层，像是镜头已经推进过几步
        const pre = Math.ceil((p.spawnDist - p.nearDist) / p.stepZ);
        for (let j = pre; j >= 1; j--) this.addLayer(p.spawnDist - j * p.stepZ, Math.min(this.lines.length - 1, pre - j), -j);

        // 每句一层：换句开始时，新层正好在 spawnDist 处
        for (let k = 0; k < this.lines.length; k++) this.addLayer(this.cameraAt(this.T[k]) + p.spawnDist, k, k);
        this.layers.sort((a, b) => a.z - b.z);
        this.dirty = false;
    }

    private addLayer(z: number, lineIdx: number, seedKey: number): void {
        const L = this.layout;
        if (!L) return;
        const p = this.params;
        const rnd = mulberry32(this.seed ^ Math.imul(seedKey + 1013, 2654435761));
        const sides: Side[] = L.portrait ? ['up', 'down'] : ['left', 'right'];
        const prevLayers = this.layers.slice(-3);
        const words: TunnelWord[] = [];
        const recent = new Set(prevLayers.flatMap((l) => l.words.map((w) => w.text)));

        for (const side of sides) {
            const count = Math.round(p.perSide[0] + rnd() * (p.perSide[1] - p.perSide[0]));
            for (let c = 0; c < count; c++) {
                const text = this.pickText(lineIdx, rnd, recent);
                if (!text) continue;
                recent.add(text);
                const ratio = this.measure(text);
                const size = L.em * p.baseSize * (p.sizeJitter[0] + rnd() * (p.sizeJitter[1] - p.sizeJitter[0]));
                let best: TunnelWord | null = null;
                let bestScore = Infinity;
                for (let tries = 0; tries < 6; tries++) {
                    const cand = this.place(L, side, text, size, ratio, rnd);
                    const score = this.overlap(cand, words, prevLayers);
                    if (score < bestScore) {
                        bestScore = score;
                        best = cand;
                        if (score === 0) break;
                    }
                }
                if (best) words.push(best);
            }
        }
        this.layers.push({ z, words });
    }

    private place(L: StageLayout, side: Side, text: string, size: number, ratio: number, rnd: () => number): TunnelWord {
        const p = this.params;
        const width = size * ratio;
        const bright = 0.5 + rnd() * 0.45;
        if (side === 'left' || side === 'right') {
            const vpOffset = L.mainHalfW + p.gap * L.em;
            const zone = Math.max(L.em, L.w / 2 - vpOffset - L.em * 0.5 - L.edgeMargin);
            // 偏向靠近主歌词的一侧，与原视频一致
            let reach = Math.max(1, zone * p.zoneFill - width * 0.6);
            if (L.edgeMargin > 0) reach = Math.max(0, Math.min(reach, L.w / 2 - L.edgeMargin - vpOffset - width));
            const ax = Math.pow(rnd(), 1.5) * reach;
            const ay = (rnd() * 2 - 1) * p.spread * L.h;
            return { text, side, ax, ay, size, bright, ratio };
        }
        const vpOffset = L.em * (0.75 + p.gap);
        const zone = Math.max(L.em, (side === 'up' ? L.centerY : L.h - L.centerY) - vpOffset - L.em);
        const ay = Math.pow(rnd(), 1.5) * zone * p.zoneFill * 0.6;
        const ax = (rnd() * 2 - 1) * Math.max(0, L.w * 0.42 - width / 2);
        return { text, side, ax, ay, size, bright, ratio };
    }

    /** 焦平面上的包围盒（相对本侧透视中心） */
    private box(w: TunnelWord): [number, number, number, number] {
        const width = w.size * w.ratio;
        if (w.side === 'left' || w.side === 'right') return [w.ax, w.ay - w.size / 2, w.ax + width, w.ay + w.size / 2];
        return [w.ax - width / 2, w.ay, w.ax + width / 2, w.ay + w.size];
    }

    private overlap(c: TunnelWord, same: TunnelWord[], prev: Layer[]): number {
        const cb = this.box(c);
        let sum = 0;
        const test = (w: TunnelWord, weight: number) => {
            if (w.side !== c.side) return;
            const b = this.box(w);
            const ox = Math.min(cb[2], b[2]) - Math.max(cb[0], b[0]);
            const oy = Math.min(cb[3], b[3]) - Math.max(cb[1], b[1]);
            if (ox > 0 && oy > 0) sum += ox * oy * weight;
        };
        for (const w of same) test(w, 1);
        prev.forEach((l, i) => l.words.forEach((w) => test(w, 0.25 + 0.25 * i)));
        return sum;
    }

    private pickText(lineIdx: number, rnd: () => number, avoid: Set<string>): string | null {
        if (!this.pool.length) return null;
        for (let attempt = 0; attempt < 8; attempt++) {
            const j = Math.max(0, Math.min(this.pool.length - 1, lineIdx + Math.round(rnd() * 6 - 3)));
            const words = this.pool.at(j);
            if (!words?.length) continue;
            const text = words[Math.floor(rnd() * words.length)];
            if (avoid.has(text) && attempt < 7) continue;
            if (text.length < 2 && attempt < 6) continue;
            return text;
        }
        return null;
    }

    /** 接下来 steps 步内会出现或正在显示的词，供渲染层提前生成贴图 */
    upcoming(t: number, steps = 2): string[] {
        if (this.dirty || !this.layout) return [];
        const p = this.params;
        const cam = this.cameraAt(t);
        const out: string[] = [];
        for (const layer of this.layers) {
            const d = layer.z - cam;
            if (d <= p.nearDist) continue;
            if (d > p.spawnDist + steps * p.stepZ) break;
            for (const w of layer.words) out.push(w.text);
        }
        return out;
    }

    // ---------- 每帧 ----------

    update(t: number): void {
        this.out.length = 0;
        const L = this.layout;
        if (!L || !this.lines.length) return;
        if (this.dirty) this.build();
        const p = this.params;
        // 两句之间只有平稳漂移：原视频里两侧的词不随节拍跳动，所以这里不接律动
        const cam = this.cameraAt(t);
        // 镜头速度（距离/秒），用对称差分，结果只取决于时间，与帧率无关
        const vel = Math.max(0, (this.cameraAt(t + 0.01) - this.cameraAt(t - 0.01)) / 0.02);

        const edge = p.edgeFade * Math.min(L.w, L.h);
        const cx = L.w / 2;

        // 二分找到第一个还没消失的层
        let lo = 0;
        let hi = this.layers.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.layers[mid].z - cam <= p.nearDist) lo = mid + 1;
            else hi = mid;
        }

        for (let i = lo; i < this.layers.length; i++) {
            const layer = this.layers[i];
            const d = layer.z - cam;
            if (d > p.spawnDist) break;
            const s = p.focusDist / d;
            const fade = smooth((p.spawnDist - d) / p.fadeIn) * smooth((d - p.nearDist) / p.fadeOut);
            const dim = 1 - (1 - p.farDim) * clamp01((d - p.focusDist) / (p.spawnDist - p.focusDist));
            // 景深模糊 + 运动模糊（屏幕速度 ∝ s² × 镜头速度）
            const blur = Math.abs(s - 1) * p.blurStrength + ((p.motionBlur * s * s) / p.focusDist) * vel;

            for (const w of layer.words) {
                const size = w.size * s;
                const width = size * w.ratio;
                let x: number;
                let y: number;
                let x0: number;
                let x1: number;
                let y0: number;
                let y1: number;
                if (w.side === 'left' || w.side === 'right') {
                    const dir = w.side === 'right' ? 1 : -1;
                    const vp = cx + dir * (L.mainHalfW + p.gap * L.em);
                    x = vp + dir * w.ax * s;
                    y = L.centerY + w.ay * s;
                    x0 = dir > 0 ? x : x - width;
                    x1 = x0 + width;
                    y0 = y - size / 2;
                    y1 = y + size / 2;
                } else {
                    const dir = w.side === 'down' ? 1 : -1;
                    const vp = L.centerY + dir * L.em * (0.75 + p.gap);
                    x = cx + w.ax * s;
                    y = vp + dir * w.ay * s;
                    x0 = x - width / 2;
                    x1 = x + width / 2;
                    y0 = dir > 0 ? y : y - size;
                    y1 = y0 + size;
                }
                const edgeFade =
                    smooth(Math.min(x0, L.w - x1) / edge + 0.5) * smooth(Math.min(y0, L.h - y1) / edge + 0.5);
                const alpha = w.bright * fade * dim * edgeFade;
                if (alpha < 0.01) continue;
                this.out.push({ text: w.text, x, y, side: w.side, size, alpha, blur, depth: d });
            }
        }
        // 远的先画
        this.out.sort((a, b) => b.depth - a.depth);
    }
}
