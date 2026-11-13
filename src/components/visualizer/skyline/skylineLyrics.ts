import type { Line } from '../../../types';
import { isInterludeLine } from '../../../utils/lyrics/parserCore';
import { segmentLyricWords } from '../../../utils/lyrics/wordSegmentation';

// src/components/visualizer/skyline/skylineLyrics.ts
// 天际样式内部用的歌词结构，以及从 Folia 的 Line[] 转换过来的函数。

/** 时间单位统一为秒 */
export interface SkyWord {
    text: string;
    start: number;
    end: number;
    /** 该词后面是否跟一个空格（渲染为独立文本节点，不参与填色） */
    space: boolean;
    /** fullText 里有、但不属于任何计时词且在最前的前导字符（标点等）：附在第一个词前面，跟着它填色 */
    prefix?: string;
    /** 同上，夹在词之后（含末词之后）的字符：附在前一个词后面，跟着它填色 */
    suffix?: string;
}

/** 一个词在画面上显示的文本：前导标点 + 计时词 + 尾随标点（空格另算，见 space） */
export const skyWordText = (w: SkyWord): string => `${w.prefix ?? ''}${w.text}${w.suffix ?? ''}`;

export interface SkyLine {
    start: number;
    end: number;
    text: string;
    words: SkyWord[];
    translation?: string;
    /** 整句按词切分的结果（只含像词的片段）：用户保存的切分优先，其次 icu-folia，最后 Intl.Segmenter */
    segments?: string[];
}

export interface SkyDoc {
    lines: SkyLine[];
    meta: Record<string, string>;
}

/**
 * 按顺序把每个词对到整句文本上，让展示文本与 fullText 一致：
 * - 有的来源把空格只留在整句文本里，逐词数据里没有（「知らない わかんないよ」）→ 两词之间隔着空白就补上空格标记；
 * - 有的来源把标点只留在整句文本里（fullText「Hello, world!」→ 词「Hello」「world」）→
 *   夹在词之间、不属于任何词的字符附到前一个词后面，首词之前的附到第一个词前面，跟着那个词一起填色。
 * 有一个词对不上时整体放弃，保持原样（此时不能相信位置关系）。
 */
function alignToFullText(words: SkyWord[], fullText: string): void {
    const starts: number[] = [];
    let cursor = 0;
    for (const w of words) {
        const at = fullText.indexOf(w.text, cursor);
        if (at < 0) return;
        starts.push(at);
        cursor = at + w.text.length;
    }
    const lead = fullText.slice(0, starts[0]).replace(/\s+/g, '');
    if (lead) words[0].prefix = lead;
    for (let i = 0; i < words.length; i++) {
        const gap = fullText.slice(starts[i] + words[i].text.length, i + 1 < words.length ? starts[i + 1] : fullText.length);
        const extra = gap.replace(/\s+/g, '');
        if (extra) words[i].suffix = extra;
        // 空白折叠成一个空格标记（多个空格、制表符都算一个）
        if (i + 1 < words.length) words[i].space = /\s/.test(gap);
    }
}

/** 返回 start <= t 的最后一行下标，没有则 -1 */
export function lineIndexAt(lines: SkyLine[], t: number): number {
    let lo = 0;
    let hi = lines.length - 1;
    let ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].start <= t) {
            ans = mid;
            lo = mid + 1;
        } else hi = mid - 1;
    }
    return ans;
}

/**
 * Folia 的 Line[] → 天际样式的 SkyLine[]。
 * Folia 的词把空格留在文字里（"Hello "），这里拆成 space 标记；纯空白的词并入前一个词的空格。
 * 没有逐词时间的行（words 为空）按整行一个词处理。
 * Folia 在超过 3 秒的空隙里插的间奏行（「......」，attachInterludes）不要：天际有自己的间奏圆点，
 * 而且把它当成一句会让两侧词云在间奏里多推进一步。
 */
export function fromFoliaLines(lines: Line[]): SkyLine[] {
    const out: SkyLine[] = [];
    for (const line of lines) {
        if (isInterludeLine(line)) continue;
        const words: SkyWord[] = [];
        for (const w of line.words) {
            const raw = w.text;
            const text = raw.trim();
            const prev = words.at(-1);
            if (!text) {
                if (prev) prev.space = true;
                continue;
            }
            if (prev && /^\s/.test(raw)) prev.space = true;
            words.push({
                text,
                start: w.startTime,
                end: Math.max(w.endTime, w.startTime + 0.01),
                space: /\s$/.test(raw),
            });
        }
        if (!words.length && line.fullText.trim()) {
            words.push({ text: line.fullText.trim(), start: line.startTime, end: line.endTime, space: false });
        }
        if (!words.length) continue; // 空行（间奏标记）不显示
        alignToFullText(words, line.fullText);
        words[words.length - 1].space = false;
        out.push({
            start: words[0].start,
            end: words[words.length - 1].end,
            text: line.fullText.trim(),
            words,
            translation: line.translation,
            segments: segmentLyricWords(line).filter(s => s.isWordLike).map(s => s.segment),
        });
    }
    out.sort((a, b) => a.start - b.start);
    return out;
}
