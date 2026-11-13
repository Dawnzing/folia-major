import { splitLyricGraphemes } from '../../../utils/lyrics/graphemeTiming';
import { segmentTextWords } from '../../../utils/lyrics/wordSegmentation';
import type { SkyLine as LyricLine } from './skylineLyrics';

// src/components/visualizer/skyline/words.ts
// 从歌词里挑出飘在两侧的词：用 Folia 的整句分词结果（SkyLine.segments），去掉单个假名之类的短助词。

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
const HIRAGANA_ONLY = /^[\u3040-\u309f\u30fc]+$/;
const TRIM_PUNCT = /^[\s"“”‘(（「『,.，。!！?？;；:：、…]+|[\s"“”(（)）」』,.，。!！?？;；:：、…]+$/g;

/** 中日文片段最多几个字：词典分词有时把整个短语（「知らないわかんないよ」）当成一段，飘在两侧太长 */
const MAX_CJK_WORD = 4;

/** 过长的中日文片段再用 Intl.Segmenter 细分；仍然过长的按字拆成 2～3 字的小块 */
const splitLong = (segment: string): string[] => {
    if (!CJK.test(segment) || splitLyricGraphemes(segment).length <= MAX_CJK_WORD) return [segment];
    const parts: string[] = [];
    for (const piece of segmentTextWords(segment)) {
        if (!piece.isWordLike) continue;
        const chars = splitLyricGraphemes(piece.segment);
        if (chars.length <= MAX_CJK_WORD) {
            parts.push(piece.segment);
            continue;
        }
        for (let i = 0; i < chars.length; i += 3) parts.push(chars.slice(i, i + 3).join(''));
    }
    return parts;
};

/** 一行歌词里适合飘在两侧的词 */
export function extractLineWords(line: LyricLine): string[] {
    const source = (line.segments?.length ? line.segments : line.words.map(w => w.text)).flatMap(splitLong);
    const out: string[] = [];
    for (const raw of source) {
        const w = raw.replace(TRIM_PUNCT, '');
        if (!w) continue;
        if (CJK.test(w)) {
            const len = splitLyricGraphemes(w).length;
            if (len < 2 && !HAN.test(w)) continue; // 单个假名（助词、语气词）；单个汉字如「神」「月」保留
            if (HIRAGANA_ONLY.test(w) && len <= 2) continue; // 平假名短词：に、の、から 之类
        }
        out.push(w);
    }
    return out;
}

export function buildWordPool(lines: LyricLine[]): string[][] {
    return lines.map(extractLineWords);
}
