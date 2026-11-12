import { splitLyricGraphemes } from '../../../utils/lyrics/graphemeTiming';
import type { SkyLine as LyricLine } from './skylineLyrics';

// src/components/visualizer/skyline/words.ts
// 从歌词里挑出飘在两侧的词：用 Folia 的整句分词结果（SkyLine.segments），去掉单个假名之类的短助词。

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
const HIRAGANA_ONLY = /^[\u3040-\u309f\u30fc]+$/;
const TRIM_PUNCT = /^[\s"“”‘(（「『,.，。!！?？;；:：、…]+|[\s"“”(（)）」』,.，。!！?？;；:：、…]+$/g;

/** 一行歌词里适合飘在两侧的词 */
export function extractLineWords(line: LyricLine): string[] {
    const source = line.segments?.length ? line.segments : line.words.map(w => w.text);
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
