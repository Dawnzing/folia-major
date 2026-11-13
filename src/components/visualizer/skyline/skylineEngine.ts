import { CenterLyrics } from './centerLyrics';
import { Canvas2DWordField } from './canvas2DWordField';
import { EASINGS } from './easing';
import { Sparks } from './sparks';
import type { SkyLine } from './skylineLyrics';
import type { SkylineTuning } from './types';
import './skyline.css';

// src/components/visualizer/skyline/skylineEngine.ts
// 天际样式的渲染引擎：不依赖 React，挂到一个容器里，由外部每帧喂播放时间和音频能量。

export interface SkylineAudio {
    /** 整体响度 0～1 */
    energy: number;
    /** 低频能量 0～1 */
    bass: number;
}

const SKYLINE_SUNG = '#ff7a6b';
const SKYLINE_UNSUNG = '#f7f3ee';

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
    private tuning: SkylineTuning;
    private readonly sung = new ColorTween(SKYLINE_SUNG);
    private readonly unsung = new ColorTween(SKYLINE_UNSUNG);
    private themeSung = SKYLINE_SUNG;
    private themeUnsung = SKYLINE_UNSUNG;
    private lastPulse = -1;
    // 简单的起音检测：低频突然升高视为一拍
    private bassAvg = 0;
    private beat = 0;
    private sinceBeat = 1;

    /**
     * @param font 字体栈（resolveThemeFontStack）
     * @param weight 字重（resolveThemeFontWeight），主歌词与两侧词云共用
     */
    constructor(container: HTMLElement, tuning: SkylineTuning, font: string, weight: number, fontJa: string = font) {
        this.tuning = tuning;
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
        requestAnimationFrame(() => this.center.refit());
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

        // 先读布局（演唱位置），再做所有样式写入，避免强制同步重排
        const head = this.center.head();

        // 律动：只作用于粒子和光晕；两侧词云不接律动（原视频里两句之间是静止的）
        const strength = this.tuning.reactStrength;
        this.detectBeat(audio.bass, playDt);
        Object.assign(this.sparks.pulse, { energy: audio.energy, beat: this.beat, onset: this.sinceBeat === 0, strength });
        const pulse = Math.round(Math.min(1, (this.beat * 0.7 + audio.bass * 0.3) * strength) * 100) / 100;
        if (pulse !== this.lastPulse) {
            this.root.style.setProperty('--sk-pulse', String(pulse));
            this.lastPulse = pulse;
        }

        const s = this.sung.step(realDt);
        const u = this.unsung.step(realDt);
        if (s || u) this.writeColors();

        this.center.update(t, playing);
        this.sparks.update(playDt, head);
        this.field.update(t);
    }

    dispose(): void {
        this.ro.disconnect();
        this.field.dispose();
        this.root.remove();
    }

    // ---------- 内部 ----------

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
            if (!faces.length || !this.root.isConnected) return;
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
        tn.invalidate();

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
        const ratio = portrait ? 0.88 : this.tuning.maxWidthRatio;
        this.root.style.setProperty('--sk-lyric-px', `${em.toFixed(2)}px`);
        this.center.maxWidthRatio = ratio;
        // 主歌词句内会放大到 growTo，两侧要按放大后的宽度留空
        this.field.setLayout({ w, h, em, centerY: h * 0.5, mainHalfW: ((w * ratio) / 2) * this.center.growTo, portrait });
        requestAnimationFrame(() => this.center.refit()); // 等新字号生效再测量
    }
}
