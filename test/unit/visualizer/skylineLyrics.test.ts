import { describe, expect, it } from 'vitest';
import type { Line, Word } from '@/types';
import { fromFoliaLines, skyWordText, type SkyWord } from '@/components/visualizer/skyline/skylineLyrics';

// test/unit/visualizer/skylineLyrics.test.ts
// 天际的主歌词只遍历计时词，但 fullText 里可能还有不属于任何计时词的标点和空白：
// 这些字符必须保留，并按相邻词一起填色（前导的附到第一个词前面，其余附到前一个词后面）。

const words = (...items: [text: string, start: number, end: number][]): Word[] => items.map(([text, startTime, endTime]) => ({ text, startTime, endTime }));

const makeLine = (fullText: string, items: Word[], overrides: Partial<Line> = {}): Line => ({
    fullText,
    words: items,
    startTime: items[0]?.startTime ?? 0,
    endTime: items[items.length - 1]?.endTime ?? 0,
    ...overrides,
});

/** 按渲染规则拼回画面上的整句：前导标点 + 计时词 + 尾随标点，后面跟一个空格标记 */
const displayText = (line: SkyWord[]): string => line.map(w => skyWordText(w) + (w.space ? ' ' : '')).join('');

describe('fromFoliaLines', () => {
    it('保留了只存在于 fullText 里的标点，并附到相邻的词上', () => {
        const [line] = fromFoliaLines([makeLine('Hello,  world!', words(['Hello', 0, 1], ['world', 1.2, 2]))]);
        expect(line.words.map(w => w.text)).toEqual(['Hello', 'world']);
        expect(line.words[0].suffix).toBe(',');
        expect(line.words[1].suffix).toBe('!');
        expect(line.words[0].space).toBe(true);
        expect(line.words[1].space).toBe(false);
        expect(displayText(line.words)).toBe('Hello, world!');
    });

    it('首词之前的标点附到第一个词前面', () => {
        const [line] = fromFoliaLines([makeLine('「知らない」 わかんないよ', words(['知らない', 0, 1], ['わかんないよ', 1.5, 3]))]);
        expect(line.words[0].prefix).toBe('「');
        expect(line.words[0].suffix).toBe('」');
        expect(line.words[0].space).toBe(true);
        expect(displayText(line.words)).toBe('「知らない」 わかんないよ');
    });

    it('多个空格折叠成一个空格标记，不留下多余空白', () => {
        const [line] = fromFoliaLines([makeLine('one   two\t\tthree', words(['one ', 0, 1], ['two ', 1, 2], ['three', 2, 3]))]);
        expect(line.words.map(w => w.space)).toEqual([true, true, false]);
        expect(displayText(line.words)).toBe('one two three');
    });

    it('重复的词按顺序对上各自的空白，不会复用一个位置', () => {
        const [line] = fromFoliaLines([makeLine('la la, la', words(['la', 0, 1], ['la', 1, 2], ['la', 2, 3]))]);
        expect(line.words.map(w => w.suffix)).toEqual([undefined, ',', undefined]);
        expect(line.words.map(w => w.space)).toEqual([true, true, false]);
        expect(displayText(line.words)).toBe('la la, la');
    });

    it('CJK 句子里夹的标点跟着前一个词', () => {
        const [line] = fromFoliaLines([makeLine('夜空を、見上げた。', words(['夜空', 0, 1], ['を', 1, 1.2], ['見上げた', 1.2, 2.5]))]);
        expect(line.words.map(w => w.suffix)).toEqual([undefined, '、', '。']);
        expect(line.words.map(w => w.space)).toEqual([false, false, false]);
        expect(displayText(line.words)).toBe('夜空を、見上げた。');
    });

    it('没有逐词时间的行整行一个词，标点本来就在里面', () => {
        const [line] = fromFoliaLines([makeLine('没有逐词时间的整句。', [], { startTime: 10, endTime: 12 })]);
        expect(line.words).toHaveLength(1);
        expect(skyWordText(line.words[0])).toBe('没有逐词时间的整句。');
        expect(line.words[0].prefix).toBeUndefined();
        expect(line.words[0].suffix).toBeUndefined();
    });

    it('逐词数据和 fullText 对不上时保持原样，不丢字', () => {
        const [line] = fromFoliaLines([makeLine('Hello world', words(['Hello ', 0, 1], ['universe', 1, 2]))]);
        expect(skyWordText(line.words[1])).toBe('universe');
        expect(line.words[0].prefix).toBeUndefined();
        expect(line.words[0].suffix).toBeUndefined();
        expect(displayText(line.words)).toBe('Hello universe');
    });

    it('跳过 Folia 插进来的间奏行', () => {
        const lines = fromFoliaLines([
            makeLine('第一句', words(['第一句', 0, 1])),
            makeLine('......', words(['.', 3, 3.5], ['.', 3.5, 4], ['.', 4, 4.5])),
            makeLine('第二句', words(['第二句', 7, 8])),
        ]);
        expect(lines.map(l => l.text)).toEqual(['第一句', '第二句']);
        expect(lines[1].start).toBe(7);
    });
});
