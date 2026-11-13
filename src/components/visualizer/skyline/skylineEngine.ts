import { CenterLyrics } from './centerLyrics';
import { Canvas2DWordField } from './canvas2DWordField';
import { EASINGS } from './easing';
import { Sparks } from './sparks';
import type { SkyLine } from './skylineLyrics';
import type { SkylineTuning } from './types';
import type { LyricRenderScale } from '../../../types';
import './skyline.css';

// src/components/visualizer/skyline/skylineEngine.ts
// 天际样式的渲染引擎：不依赖 React，挂到一个容器里，由外部每帧喂播放时间和音频能量。

export interface SkylineAudio {
    /** 整体响度 0～1 */
    energy: number;
    /** 低频能量 0～1 */
    bass: number;
}

export interface SkylineEngineOptions {
    /** 预览小图：主歌词更宽、两侧词云留安全边（正式播放画面不变） */
    preview?: boolean;
    /** 词云画布的分辨率倍数（全局歌词分辨率，导出时可能是钉住的值） */
    renderScale?: LyricRenderScale;
}

const SKYLINE_SUNG = '#ff7a6b';
const SKYLINE_UNSUNG = '#f7f3ee';
// 预览的样式选择器把 16:9 舞台裁进 16:10，左右各少约 5%：两侧词云给左右各留 8% 安全边
// （主歌词宽度不放宽：放宽会把两侧词云挤到边上，小图里长句本来也看不清，构图更重要）
const PREVIEW_EDGE_MARGIN = 0.08;
/** 歌词时间跳变超过这么久视为换歌 / 跳转 */
const LYRIC_JUMP_SEC = 1;

const hexToRgb = (hex: string): [number, number, number] => {
    const h = hex.replace('#', '').trim();
    const full = h.length === 3 ? h.replace(/(.)/g, '$1$1') : h.slice(0, 6);
    const n = parseInt(full, 16);
    return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [255, 255, 255];
};
const rgbToHex = (c: readonly number[]) => '#' + c.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

/** 颜色平滑过渡（换歌时主题色变化不跳变） */
class ColorTween {
    private cur: [number, number, number];
    private target: [number, number, number];
    constructor(hex: string) {
        this.cur = hexToRgb(hex);
        this.target = [...this.cur];
    }
    set(hex: string, immediate: boolean): void {
        this.target = hexToRgb(hex);
        if (immediate) this.cur = [...this.target];
    }
    /** 推进一帧，返回是否有变化 */
    step(dt: number): boolean {
        let moved = false;
        const k = 1 - Math.exp(-dt * 3);
        for (let i = 0; i < 3; i++) {
            const d = this.target[i] - this.cur[i];
            if (Math.abs(d) < 0.5) {
                if (this.cur[i] !== this.target[i]) moved = true;
                this.cur[i] = this.target[i];
            } else {
                this.cur[i] += d * k;
                moved = true;
            }
        }
        return moved;
    }
    get hex(): string {
        return rgbToHex(this.cur);
    }
}

export class SkylineEngine {
    readonly root: HTMLDivElement;
    private readonly fieldCanvas: HTMLCanvasElement;
    private readonly centerHost: HTMLDivElement;
    private readonly center: CenterLyrics;
    private readonly field: Canvas2DWordField;
    private readonly sparks: Sparks;
    private readonly ro: ResizeObserver;
    private readonly preview: boolean;
    private tuning: SkylineTuning;
    private readonly sung = new ColorTween(SKYLINE_SUNG);
    private readonly unsung = new ColorTween(SKYLINE_UNSUNG);
    private themeSung = SKYLINE_SUNG;
    private themeUnsung = SKYLINE_UNSUNG;
    private lastPulse = -1;
    /** 上一帧的歌词时间：用来识别换歌 / 跳转（粒子要清尾迹） */
    private lastT = Number.NaN;
    private disposed = false;
    /** 挂起的下一帧回调（字体加载、布局后重新测量），卸载时一并取消 */
    private readonly rafs = new Set<number>();
    // 简单的起音检测：低频突然升高视为一拍
    private bassAvg = 0;
    private beat = 0;
    private sinceBeat = 1;

    /**
     * @param font 字体栈（resolveThemeFontStack）
     * @param weight 字重（resolveThemeFontWeight），主歌词与两侧词云共用
     */
    constructor(
        container: HTMLElement,
        tuning: SkylineTuning,
        font: string,
        weight: number,
        fontJa: string = font,
        options: SkylineEngineOptions = {},
    ) {
        this.tuning = tuning;
        this.preview = options.preview ?? false;
        this.root = document.createElement('div');
        this.root.className = 'sk-root';
        this.fieldCanvas = document.createElement('canvas');
        this.fieldCanvas.className = 'sk-layer sk-field';
        this.centerHost = document.createElement('div');
        this.centerHost.className = 'sk-layer sk-center';
        this.root.append(this.fieldCanvas, this.centerHost);
        container.append(this.root);
        this.setFontVars(font, fontJa, weight);

        this.center = new CenterLyrics(this.centerHost);
        this.field = new Canvas2DWordField(this.fieldCanvas, SKYLINE_SUNG, font, fontJa, weight);
        this.field.setRenderScale(options.renderScale ?? 1);
        this.sparks = new Sparks();
        this.field.overlays.push((ctx, dpr) => this.sparks.render(ctx, dpr)); // 粒子画在词云同一块画布上

        this.loadFonts(weight);
        this.applyTuning(true);
        this.ro = new ResizeObserver(() => this.relayout());
        this.ro.observe(this.root);
        this.relayout();
    }

    setLines(lines: SkyLine[], title?: string | null, artist?: string | null): void {
        const meta: Record<string, string> = {};
        if (title) meta.ti = title;
        if (artist) meta.ar = artist;
        const doc = { lines, meta };
        this.center.setDoc(doc);
        this.field.setDoc(doc);
        // 换歌：上一首的尾迹和起音状态不能带过来（离场句不受影响）
        this.resetSparks();
    }

    /** 宿主的主题色（tuning.colorMode 为 theme 时使用） */
    setThemeColors(sung: string, unsung: string, immediate = false): void {
        this.themeSung = sung;
        this.themeUnsung = unsung;
        this.applyColors(immediate);
    }

    setFont(font: string, weight: number, fontJa: string = font): void {
        this.setFontVars(font, fontJa, weight);
        this.field.setFont(font, fontJa, weight);
        this.loadFonts(weight);
        this.afterFrame(() => this.center.refit());
    }

    /** 全局歌词分辨率挡位变了（画布像素密度） */
    setRenderScale(scale: LyricRenderScale): void {
        this.field.setRenderScale(scale);
    }

    /** 让下一帧无条件重画（隐藏后恢复、需要补画时） */
    invalidate(): void {
        this.field.invalidate();
    }

    setTuning(tuning: SkylineTuning): void {
        this.tuning = tuning;
        this.applyTuning(false);
    }

    /**
     * 每帧调用。
     * @param t 歌词时间（秒）
     * @param dt 距上一帧的真实秒数
     * @param playing 是否在播放（暂停时粒子停住）
     */
    frame(t: number, dt: number, playing: boolean, audio: SkylineAudio): void {
        const realDt = Math.min(0.1, Math.max(0, dt));
        const playDt = playing ? realDt : 0;

        // 换歌 / 拖动进度条：歌词时间倒退或一次跳太远时清尾迹，别把旧位置上的粒子留在画面上
        if (Number.isFinite(this.lastT) && (t < this.lastT - 1e-3 || t - this.lastT > LYRIC_JUMP_SEC)) this.resetSparks();
        this.lastT = t;

        // 先读布局（演唱位置），再做所有样式写入，避免强制同步重排
        const head = this.center.head();

        // 律动：只作用于粒子和光晕；两侧词云不接律动（原视频里两句之间是静止的）
        const strength = this.tuning.reactStrength;
        this.detectBeat(audio.bass, playDt);
        Object.assign(this.sparks.pulse, { energy: audio.energy, beat: this.beat, onset: this.sinceBeat === 0, strength });
        // 只给正在唱的词的光晕用：量化到 0.1 一档并只写在主歌词层上。--sk-pulse 会被继承，
        // 每帧都写（低频归一化后几乎每帧在变）会让整个歌词子树逐帧重算样式，实测掉约 10fps
        const pulse = Math.round(Math.min(1, (this.beat * 0.7 + audio.bass * 0.3) * strength) * 10) / 10;
        if (pulse !== this.lastPulse) {
            this.centerHost.style.setProperty('--sk-pulse', String(pulse));
            this.lastPulse = pulse;
        }

        const s = this.sung.step(realDt);
        const u = this.unsung.step(realDt);
        if (s || u) this.writeColors();

        this.center.update(t, playing);
        this.sparks.update(playDt, head);
        this.field.update(t, playing);
    }

    dispose(): void {
        this.disposed = true;
        for (const id of this.rafs) cancelAnimationFrame(id);
        this.rafs.clear();
        this.ro.disconnect();
        this.center.dispose();
        this.field.dispose();
        this.root.remove();
    }

    // ---------- 内部 ----------

    /** 下一帧执行一件事；卸载时取消（字体加载、布局测量都是异步的） */
    private afterFrame(fn: () => void): void {
        const id = requestAnimationFrame(() => {
            this.rafs.delete(id);
            if (!this.disposed) fn();
        });
        this.rafs.add(id);
    }

    /** 清粒子尾迹，并重置低频起音检测状态 */
    private resetSparks(): void {
        this.sparks.reset();
        this.bassAvg = 0;
        this.beat = 0;
        this.sinceBeat = 1;
        this.lastPulse = -1;
    }

    private detectBeat(bass: number, dt: number): void {
        this.beat *= Math.exp(-dt * 5);
        this.sinceBeat = dt > 0 ? this.sinceBeat + dt : this.sinceBeat;
        if (dt <= 0) return;
        this.bassAvg += (bass - this.bassAvg) * (1 - Math.exp(-dt * 2));
        if (bass > this.bassAvg * 1.35 + 0.05 && this.sinceBeat > 0.22) {
            this.beat = Math.min(1, (bass - this.bassAvg) * 3);
            this.sinceBeat = 0;
        }
    }

    /** Canvas 画字不会触发网页字体下载：主动加载天际衬线，到了再刷新词云贴图、重新测量主歌词 */
    private loadFonts(weight: number): void {
        void document.fonts.load(`${weight} 64px "Skyline Serif Display"`, 'Skyline').then((faces) => {
            if (this.disposed || !faces.length || !this.root.isConnected) return;
            this.field.refreshFonts();
            this.center.refit();
        }, () => undefined);
    }

    private setFontVars(font: string, fontJa: string, weight: number): void {
        this.root.style.setProperty('--sk-font', font);
        this.root.style.setProperty('--sk-font-ja', fontJa);
        this.root.style.setProperty('--sk-weight', String(weight));
        // 下一句预览比当前句轻一档
        this.root.style.setProperty('--sk-weight-light', String(Math.max(100, weight - 200)));
    }

    private applyColors(immediate: boolean): void {
        const theme = this.tuning.colorMode === 'theme';
        this.sung.set(theme ? this.themeSung : SKYLINE_SUNG, immediate);
        this.unsung.set(theme ? this.themeUnsung : SKYLINE_UNSUNG, immediate);
        if (immediate) this.writeColors();
    }

    private writeColors(): void {
        const sung = this.sung.hex;
        this.root.style.setProperty('--sk-sung', sung);
        this.root.style.setProperty('--sk-unsung', this.unsung.hex);
        this.field.setColor(sung);
    }

    private applyTuning(initial: boolean): void {
        const t = this.tuning;
        const tn = this.field.tunnel;
        const c = this.center;
        // 句内放大比例 r：从 1/√r 放大到 √r，中点正好是原始大小
        const r = Math.max(1, t.grow);
        const structural =
            initial ||
            t.emphasize !== c.emphasize ||
            t.fadeWidth !== c.fadeWidth ||
            t.float !== c.float ||
            Math.abs(c.growTo - Math.sqrt(r)) > 1e-6;
        c.lead = tn.lead = t.lead;
        c.growFrom = 1 / Math.sqrt(r);
        c.growTo = Math.sqrt(r);
        c.fadeWidth = t.fadeWidth;
        c.float = t.float;
        c.emphasize = t.emphasize;
        c.interludeMin = t.interludeMin;
        c.retireMs = Math.max(900, t.duration * 1000 + 250);

        const p = tn.params;
        p.duration = t.duration;
        p.easing = t.easing;
        p.driftShare = t.driftShare;
        p.perSide = [t.perSideMin, Math.max(t.perSideMin, t.perSideMax)];
        p.baseSize = t.wordSize;
        p.spread = t.spread;
        p.blurStrength = t.blurStrength;
        p.motionBlur = t.motionBlur;
        p.farDim = t.farDim;
        this.field.invalidate();

        this.sparks.params.rate = t.sparkRate;

        const st = this.root.style;
        st.setProperty('--sk-switch-dur', `${t.duration}s`);
        st.setProperty('--sk-switch-ease', EASINGS[t.easing].css);
        st.setProperty('--sk-fade-width', String(t.fadeWidth));
        st.setProperty('--sk-glow', String(t.glow));
        this.applyColors(initial);
        if (structural) c.rebuild();
        this.relayout();
    }

    /** 按容器大小与宽高比布局：宽屏左右放词，竖屏上下放词 */
    private relayout(): void {
        const w = this.root.clientWidth;
        const h = this.root.clientHeight;
        if (!w || !h) return;
        const portrait = w / h < 0.9;
        const scale = this.tuning.lyricScale;
        const em = portrait
            ? Math.min(64, Math.max(22, Math.min(w * 0.065, h * 0.045))) * scale
            : Math.min(96, Math.max(24, Math.min(w * 0.032, h * 0.07))) * scale;
        // 竖屏行宽占满大半个容器：先除开句内放大倍率，否则句末放大后行首尾会被裁掉
        const ratio = portrait ? 0.88 / this.center.growTo : this.tuning.maxWidthRatio;
        this.root.style.setProperty('--sk-lyric-px', `${em.toFixed(2)}px`);
        this.center.maxWidthRatio = ratio;
        // 主歌词句内会放大到 growTo：适宽要先除开它（竖屏与预览），两侧也要按放大后的宽度与安全边留空
        this.field.setLayout({
            w,
            h,
            em,
            centerY: h * 0.5,
            mainHalfW: ((w * ratio) / 2) * this.center.growTo,
            edgeMargin: this.preview ? w * PREVIEW_EDGE_MARGIN : 0,
            portrait,
        });
        this.afterFrame(() => this.center.refit()); // 等新字号生效再测量
    }
}
