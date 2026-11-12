import { splitLyricGraphemes } from '../../../utils/lyrics/graphemeTiming';
import { cubicBezier } from './easing';
import { TimedAnim } from './timedAnim';
import { lineIndexAt, type SkyDoc as LyricDoc, type SkyWord as LyricWord } from './skylineLyrics';

// src/components/visualizer/skyline/centerLyrics.ts
// 中间主歌词（DOM）：换句过渡、句内放大、连续填色边缘、上浮、长音强调、间奏圆点。

type State = 'enter' | 'next' | 'current' | 'past';

/** 填色单元：普通词是整个词，长音强调的词是其中每个字符 */
interface Unit {
    el: HTMLElement;
    left: number;
    width: number;
    last: number;
}

interface Emphasis {
    chars: HTMLElement[];
    /** 强调时长（秒，至少 1 秒） */
    du: number;
    amount: number;
    blur: number;
    last: string[];
}

interface WordView {
    el: HTMLElement;
    data: LyricWord;
    left: number;
    right: number;
    units: Unit[];
    emph: Emphasis | null;
    active: boolean;
    lastFloat: number;
}

interface LineView {
    idx: number;
    el: HTMLElement;
    /** 内层：承载句内渐渐放大（外层负责换句过渡，两者互不干扰） */
    inner: HTMLElement;
    words: WordView[];
    /** 填色过渡带宽度（布局 px） */
    feather: number;
    /** 句内放大：合成器动画，按歌词时间同步 */
    growAnim: TimedAnim | null;
}

const TITLE_IDX = -1;
const KANA = /[\u3040-\u30ff]/;
const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;
const easeOut = cubicBezier(0, 0, 0.58, 1);
// 长音强调曲线：前半段上扬，后半段回落
const bezIn = cubicBezier(0.2, 0.4, 0.58, 1);
const bezOut = cubicBezier(0.3, 0, 0.58, 1);
const empEase = (x: number) => (x < 0.5 ? bezIn(x / 0.5) : 1 - bezOut((x - 0.5) / 0.5));
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 中间主歌词：当前句（逐字填色）+ 下一句预览 + 间奏圆点。
 *
 * - 换句：当前句上移淡出模糊；预览句放大成为当前句；再从下方淡入新的预览。
 * - 句内：当前句按"这句唱到哪了"匀速放大（原视频实测约 1.35～1.4 倍）。
 * - 填色：整行一条连续的填色边缘，过渡带宽度固定（相对字高），词间空隙处停住等待。
 * - 上浮：每个词开唱后缓缓上浮一点；长音（≥1 秒）逐字放大、推开、上浮回落并发光。
 * - 间奏：句间空隙足够长时主歌词淡出，显示三个随进度点亮的呼吸圆点。
 *
 * 每帧由 JS 计算，只改动正在变化的元素，并且直接写 transform 而不是 CSS 自定义变量
 * （自定义变量会被子元素继承，每改一次整行都要重算样式）。
 * 不用合成器动画：每个动画元素都会变成独立 GPU 图层，高分屏 + 高刷新率下 GPU 会被压满。
 */
export class CenterLyrics {
    /** 提前多少秒开始换句，让过渡动画在开唱时刚好完成 */
    lead = 0.25;
    /** 当前句最大宽度（占舞台宽度的比例），超出会等比缩小 */
    maxWidthRatio = 0.38;
    /** 离场的旧句多久后移除（需大于换句动画时长） */
    retireMs = 900;
    /** 句内放大：从 growFrom 匀速放大到 growTo */
    growFrom = 0.89;
    growTo = 1.12;
    /** 填色过渡带宽度（相对字高） */
    fadeWidth = 0.5;
    /** 唱过的字上浮多少（相对字高），0 关闭 */
    float = 0.05;
    /** 长音强调 */
    emphasize = true;
    /** 间奏圆点：空隙至少多少秒才显示，0 关闭 */
    interludeMin = 4;

    private doc: LyricDoc | null = null;
    private idx = -2;
    private cur: LineView | null = null;
    private next: LineView | null = null;
    private readonly head_ = { x: 0, active: false };
    private readonly dots: HTMLElement;
    private readonly dotEls: HTMLElement[];
    private lastDots = '';

    constructor(private readonly host: HTMLElement) {
        this.dots = document.createElement('div');
        this.dots.className = 'sk-interlude';
        this.dotEls = [0, 1, 2].map(() => this.dots.appendChild(document.createElement('i')));
        host.append(this.dots);
        new ResizeObserver(() => this.refit()).observe(host);
        void document.fonts.ready.then(() => this.refit());
    }

    setDoc(doc: LyricDoc): void {
        this.doc = doc;
        this.idx = -2;
        this.cur = this.next = null;
        this.clearLines();
    }

    /** 改了会影响 DOM 结构的参数（如长音强调开关）后调用 */
    rebuild(): void {
        this.idx = -2;
    }

    update(t: number, playing = true): void {
        const doc = this.doc;
        if (!doc) return;
        const idx = lineIndexAt(doc.lines, t + this.lead);
        if (idx !== this.idx) {
            if (idx === this.idx + 1 && this.idx >= -1) this.advance(idx);
            else this.jump(idx);
            this.idx = idx;
        }
        this.head_.active = false;
        if (this.cur) {
            this.paint(this.cur, t);
            this.grow(this.cur, idx, t, playing);
        }
        this.interlude(idx, t);
    }

    /**
     * 演唱位置（相对 host 的 CSS px）：x = 填色边缘，y = 文字顶部，em = 当前字号。
     * 没有在唱（句间空隙、标题、间奏）时返回 null。
     */
    head(): { x: number; y: number; em: number } | null {
        const v = this.cur;
        if (!v || !this.head_.active) return null;
        const r = v.inner.getBoundingClientRect();
        const h = this.host.getBoundingClientRect();
        const scale = v.inner.offsetWidth ? r.width / v.inner.offsetWidth : 1;
        const em = r.height / 1.2;
        return { x: r.left - h.left + this.head_.x * scale, y: r.top - h.top + (r.height - em) / 2 + em * 0.12, em };
    }

    // ---- 状态切换 ----

    private advance(idx: number): void {
        if (this.cur) this.retire(this.cur);
        if (this.next && this.next.idx === idx) {
            this.cur = this.next;
            this.setState(this.cur, 'current');
        } else {
            this.cur = this.make(idx, 'current');
        }
        this.next = this.make(idx + 1, 'enter');
        if (this.next) {
            const n = this.next;
            n.el.getBoundingClientRect(); // 强制回流，让 enter → next 产生过渡
            this.setState(n, 'next');
        }
    }

    /** 跳转（seek / 首次）：直接摆好，不做动画 */
    private jump(idx: number): void {
        this.clearLines();
        this.host.classList.add('sk-no-anim');
        this.cur = this.make(idx, 'current');
        this.next = this.make(idx + 1, 'next');
        this.host.getBoundingClientRect(); // 强制回流，让 no-anim 先生效
        requestAnimationFrame(() => this.host.classList.remove('sk-no-anim'));
    }

    private retire(view: LineView): void {
        view.growAnim?.freeze(); // 离场时保持最后的大小
        this.setState(view, 'past');
        view.el.classList.remove('sk-title');
        setTimeout(() => view.el.remove(), this.retireMs);
    }

    private setState(view: LineView, state: State): void {
        view.el.dataset.state = state;
    }

    private clearLines(): void {
        for (const v of [this.cur, this.next]) v?.growAnim?.cancel();
        for (const el of [...this.host.querySelectorAll('.sk-line')]) el.remove();
    }

    // ---- DOM ----

    private make(idx: number, state: State): LineView | null {
        const doc = this.doc;
        if (!doc) return null;
        const el = document.createElement('div');
        el.className = 'sk-line';
        el.dataset.state = state;
        const inner = document.createElement('span');
        inner.className = 'sk-grow';
        inner.style.transform = `scale(${this.growFrom})`;
        el.append(inner);
        const words: WordView[] = [];

        if (idx === TITLE_IDX) {
            const title = doc.meta.ti;
            if (!title) return null;
            el.classList.add('sk-title');
            inner.textContent = doc.meta.ar ? `${title} · ${doc.meta.ar}` : title;
            if (KANA.test(inner.textContent)) el.lang = 'ja';
        } else {
            const line = doc.lines.at(idx);
            if (!line) return null;
            if (KANA.test(line.text)) el.lang = 'ja'; // 日文字形优先
            const lastIdx = line.words.length - 1;
            line.words.forEach((w, i) => {
                const span = document.createElement('span');
                span.className = 'sk-w';
                const emph = this.emphasize ? emphasisFor(w, i === lastIdx) : null;
                const units: Unit[] = [];
                if (emph) {
                    for (const ch of splitLyricGraphemes(w.text)) {
                        const c = document.createElement('span');
                        c.className = 'sk-c sk-u';
                        c.textContent = ch;
                        span.append(c);
                        emph.chars.push(c);
                        units.push({ el: c, left: 0, width: 0, last: NaN });
                    }
                    emph.last = emph.chars.map(() => '');
                } else {
                    span.classList.add('sk-u');
                    span.textContent = w.text;
                    units.push({ el: span, left: 0, width: 0, last: NaN });
                }
                inner.append(span);
                if (w.space) inner.append(' ');
                words.push({ el: span, data: w, left: 0, right: 0, units, emph, active: false, lastFloat: NaN });
            });
        }

        this.host.append(el);
        const view: LineView = { idx, el, inner, words, feather: 0, growAnim: null };
        this.fit(el);
        this.measure(view);
        return view;
    }

    /** 测量各词、各字在行内的位置（布局 px，不受 transform 影响） */
    private measure(view: LineView): void {
        const base = offsetTo(view.inner, view.el);
        view.feather = (parseFloat(getComputedStyle(view.el).fontSize) || 16) * this.fadeWidth;
        for (const w of view.words) {
            w.left = offsetTo(w.el, view.el) - base;
            w.right = w.left + w.el.offsetWidth;
            for (const u of w.units) {
                u.left = offsetTo(u.el, view.el) - base;
                u.width = u.el.offsetWidth;
                u.last = NaN;
            }
        }
    }

    private fit(el: HTMLElement): void {
        const max = this.host.clientWidth * this.maxWidthRatio;
        const w = el.offsetWidth;
        el.style.setProperty('--fit', w > max && w > 0 ? (max / w).toFixed(4) : '1');
    }

    refit(): void {
        for (const el of this.host.querySelectorAll<HTMLElement>('.sk-line')) this.fit(el);
        for (const v of [this.cur, this.next]) if (v) this.measure(v);
    }

    // ---- 每帧 ----

    /** 整行连续的填色边缘位置（相对内层左侧，布局 px） */
    private edgeAt(view: LineView, t: number): number {
        const ws = view.words;
        const half = view.feather / 2;
        if (!ws.length) return 0;
        if (t < ws[0].data.start) return ws[0].left - half * 2;
        for (let i = 0; i < ws.length; i++) {
            const w = ws[i];
            if (t < w.data.start) return ws[i - 1].right + half; // 词间空隙：停在上一个词末尾
            if (t < w.data.end) {
                this.head_.active = true;
                const p = (t - w.data.start) / (w.data.end - w.data.start);
                return w.left - half + (w.right - w.left + half * 2) * p;
            }
        }
        return ws[ws.length - 1].right + half * 2;
    }

    private paint(view: LineView, t: number): void {
        const x = this.edgeAt(view, t);
        this.head_.x = x;
        const f = view.feather;
        for (const w of view.words) {
            // 填色：每个单元的边缘位置 = 整行边缘 - 单元左侧
            for (const u of w.units) {
                let e = x - u.left;
                e = e < -f ? -f : e > u.width + f ? u.width + f : Math.round(e * 10) / 10;
                if (e !== u.last) {
                    u.last = e;
                    u.el.style.setProperty('--edge', `${e}px`);
                }
            }
            const d = w.data;
            const active = t >= d.start && t < d.end;
            if (active !== w.active) {
                w.active = active;
                w.el.classList.toggle('sk-active', active && !w.emph);
            }
            // 上浮：开唱后在至少 1 秒内缓缓上浮（先快后慢）
            const fy =
                this.float > 0 && t > d.start
                    ? Math.round(this.float * easeOut(clamp01((t - d.start) / Math.max(1, d.end - d.start))) * 10000) / 10000
                    : 0;
            if (fy !== w.lastFloat) {
                w.lastFloat = fy;
                w.el.style.transform = fy ? `translateY(${-fy}em)` : '';
            }
            if (w.emph) paintEmphasis(w.emph, d.start, t);
        }
    }

    /**
     * 句内匀速放大：进度 = 从本句换句开始到下一句换句开始。
     * 交给合成器动画（整行一个图层），避免每帧重新栅格化整行文字。
     */
    private grow(view: LineView, idx: number, t: number, playing: boolean): void {
        if (!view.growAnim && this.doc) {
            const lines = this.doc.lines;
            let from: number;
            let to: number;
            if (idx < 0) {
                from = Math.min(0, (lines[0]?.start ?? 0) - this.lead);
                to = (lines[0]?.start ?? 1) - this.lead;
            } else {
                from = lines[idx].start - this.lead;
                to = lines[idx + 1] ? lines[idx + 1].start - this.lead : Math.max(from + 1, lines[idx].end + 2);
            }
            const anim = view.inner.animate([{ transform: `scale(${this.growFrom})` }, { transform: `scale(${this.growTo})` }], {
                duration: Math.max(1, (to - from) * 1000),
                easing: 'linear',
                fill: 'both',
            });
            view.growAnim = new TimedAnim(anim, from);
        }
        view.growAnim?.sync(t, playing);
    }

    /**
     * 间奏圆点：句间（含片头）空隙 ≥ interludeMin 秒时显示。
     * 0.5 秒淡入；随间奏进度依次点亮三个点并轻微呼吸；换句前 0.75 秒先略放大再收缩消失。
     */
    private interlude(idx: number, t: number): void {
        const lines = this.doc?.lines ?? [];
        const next = lines.at(idx + 1);
        let on = false;
        let opacity = 0;
        let scale = 1;
        const lit = [0, 0, 0];
        if (this.interludeMin > 0 && next) {
            const gapStart = idx < 0 ? 1.2 : lines[idx].end + 0.3;
            const gapEnd = next.start - this.lead; // 与换句同时结束
            if (gapEnd - gapStart >= this.interludeMin - 0.3 && t >= gapStart && t < gapEnd) {
                on = true;
                const prog = (t - gapStart) / (gapEnd - gapStart);
                const toEnd = gapEnd - t;
                opacity = clamp01((t - gapStart) / 0.5);
                scale = 1 + 0.06 * Math.sin(((t - gapStart) / 1.6) * Math.PI * 2);
                if (toEnd < 0.75) {
                    const k = 1 - toEnd / 0.75;
                    scale = k < 0.7 ? 1 + 0.15 * easeOut(k / 0.7) : 1.15 * (1 - easeOut((k - 0.7) / 0.3));
                    opacity = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
                }
                for (let i = 0; i < 3; i++) lit[i] = clamp01((prog * 3 - i) * 1.5);
            }
        }
        this.host.toggleAttribute('data-sk-interlude', on);
        const key = on ? `${opacity.toFixed(3)}|${scale.toFixed(3)}|${lit.map((l) => l.toFixed(2)).join(',')}` : '';
        if (key === this.lastDots) return;
        this.lastDots = key;
        this.dots.style.opacity = on ? opacity.toFixed(3) : '0';
        this.dots.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
        this.dotEls.forEach((d, i) => (d.style.opacity = (0.2 + 0.7 * lit[i]).toFixed(3)));
    }
}

/** 长音强调参数（参考 AMLL 的取值：音越长越强，句末最后一个长音再加强） */
function emphasisFor(w: LyricWord, isLast: boolean): Emphasis | null {
    const dur = w.end - w.start;
    const text = w.text.trim();
    const ok = CJK.test(text) ? dur >= 1 : dur >= 1 && text.length > 1 && text.length <= 7;
    if (!ok) return null;
    let du = Math.max(1, dur);
    let amount = du / 2;
    amount = (amount > 1 ? Math.sqrt(amount) : amount ** 3) * 0.6;
    let blur = du / 3;
    blur = (blur > 1 ? Math.sqrt(blur) : blur ** 3) * 0.5;
    if (isLast) {
        amount *= 1.6;
        blur *= 1.5;
        du *= 1.2;
    }
    return { chars: [], du, amount: Math.min(1.2, amount), blur: Math.min(0.8, blur), last: [] };
}

/** 长音强调：逐字依次放大、左右推开、上浮回落并发光（只在强调期间每帧更新这几个字） */
function paintEmphasis(e: Emphasis, start: number, t: number): void {
    const n = e.chars.length;
    for (let i = 0; i < n; i++) {
        const de = start + (e.du / 2.5 / n) * i;
        const t0 = de - 0.4; // 上浮比放大发光提前 0.4 秒开始
        const k = empEase(clamp01((t - de) / e.du));
        const bump = Math.sin(clamp01((t - t0) / (e.du * 1.4)) * Math.PI);
        const key = k < 0.001 && bump < 0.001 ? '' : `${k.toFixed(3)}|${bump.toFixed(3)}`;
        if (key === e.last[i]) continue;
        e.last[i] = key;
        const c = e.chars[i];
        if (!key) {
            c.style.transform = '';
            c.style.textShadow = '';
            continue;
        }
        const scale = 1 + k * 0.1 * e.amount;
        const dx = -k * 0.03 * e.amount * (n / 2 - i);
        const dy = -k * 0.025 * e.amount - bump * 0.05;
        const glow = k * e.blur;
        c.style.transform = `translate(${dx.toFixed(4)}em, ${dy.toFixed(4)}em) scale(${scale.toFixed(4)})`;
        c.style.textShadow =
            glow > 0.005 ? `0 0 ${Math.min(0.3, e.blur * 0.3).toFixed(3)}em rgba(255,255,255,${glow.toFixed(3)})` : '';
    }
}

/**
 * 元素相对 ancestor 的水平偏移（布局 px，不含 transform）。
 * 带 transform 的元素会成为子元素的 offsetParent，所以要沿链逐层累加。
 */
function offsetTo(el: HTMLElement, ancestor: HTMLElement): number {
    let x = 0;
    let node: HTMLElement | null = el;
    while (node && node !== ancestor) {
        x += node.offsetLeft;
        node = node.offsetParent as HTMLElement | null;
    }
    return x;
}
