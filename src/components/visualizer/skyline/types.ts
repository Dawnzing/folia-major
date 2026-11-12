import type { EasingName } from './easing';

// src/components/visualizer/skyline/types.ts
// 天际样式的可调参数和默认值（默认值来自对原视频的逐帧实测，见 skyline/README.md）。

export type SkylineColorMode = 'skyline' | 'theme';

export interface SkylineTuning {
    // ---- 主歌词 ----
    /** 字号倍率 */
    lyricScale: number;
    /** 宽屏时当前句最大宽度（占舞台宽度的比例） */
    maxWidthRatio: number;
    /** 提前多少秒开始换句 */
    lead: number;
    /** 句内放大比例（从 1/√r 匀速放大到 √r） */
    grow: number;
    /** 填色过渡带宽度（字高） */
    fadeWidth: number;
    /** 唱过的字上浮（字高），0 关闭 */
    float: number;
    /** 长音强调 */
    emphasize: boolean;
    /** 间奏圆点：空隙至少多少秒才显示，0 关闭 */
    interludeMin: number;
    // ---- 换句动画 ----
    /** 换句推进时长（秒），主歌词与两侧词云共用 */
    duration: number;
    easing: EasingName;
    /** 每一轮里句内匀速前进的比例（其余在换句时推进） */
    driftShare: number;
    // ---- 两侧词云 ----
    perSideMin: number;
    perSideMax: number;
    /** 焦平面字号（相对主歌词） */
    wordSize: number;
    /** 竖直分散（占高度比例） */
    spread: number;
    blurStrength: number;
    motionBlur: number;
    farDim: number;
    // ---- 粒子与律动 ----
    sparkRate: number;
    /** 律动强度（只作用于粒子和光晕） */
    reactStrength: number;
    // ---- 颜色 ----
    /** skyline：天际原色（珊瑚红 / 暖白）；theme：跟随 Folia 的主题色 */
    colorMode: SkylineColorMode;
    /** 背景中央的主题色光晕强度 */
    glow: number;
}

export const DEFAULT_SKYLINE_TUNING: SkylineTuning = {
    lyricScale: 1,
    maxWidthRatio: 0.46,
    lead: 0.25,
    grow: 1.35,
    fadeWidth: 0.5,
    float: 0.05,
    emphasize: true,
    interludeMin: 4,
    duration: 0.75,
    easing: 'smooth',
    driftShare: 0.5,
    perSideMin: 2,
    perSideMax: 3,
    wordSize: 0.85,
    spread: 0.14,
    blurStrength: 6,
    motionBlur: 0.22,
    farDim: 0.35,
    sparkRate: 95,
    reactStrength: 1,
    colorMode: 'skyline',
    glow: 0.1,
};

type NumberKey = { [K in keyof SkylineTuning]: SkylineTuning[K] extends number ? K : never }[keyof SkylineTuning];

/** 每个数值参数的取值范围：存储读取时的夹取、模组可写范围、设置面板的滑块共用这一份 */
export const SKYLINE_RANGES: Record<NumberKey, { min: number; max: number; step: number; integer?: boolean }> = {
    lyricScale: { min: 0.6, max: 1.6, step: 0.01 },
    maxWidthRatio: { min: 0.25, max: 0.7, step: 0.01 },
    lead: { min: 0, max: 0.8, step: 0.01 },
    grow: { min: 1, max: 1.6, step: 0.01 },
    fadeWidth: { min: 0.05, max: 2, step: 0.05 },
    float: { min: 0, max: 0.2, step: 0.005 },
    interludeMin: { min: 0, max: 10, step: 0.5 },
    duration: { min: 0.2, max: 1.5, step: 0.01 },
    driftShare: { min: 0, max: 1, step: 0.01 },
    perSideMin: { min: 0, max: 4, step: 1, integer: true },
    perSideMax: { min: 0, max: 4, step: 1, integer: true },
    wordSize: { min: 0.3, max: 2, step: 0.01 },
    spread: { min: 0, max: 0.4, step: 0.005 },
    blurStrength: { min: 0, max: 12, step: 0.5 },
    motionBlur: { min: 0, max: 1, step: 0.01 },
    farDim: { min: 0, max: 1, step: 0.01 },
    sparkRate: { min: 0, max: 300, step: 1, integer: true },
    reactStrength: { min: 0, max: 2, step: 0.05 },
    glow: { min: 0, max: 0.4, step: 0.01 },
};

export const SKYLINE_EASINGS = ['smooth', 'out', 'swift', 'spring', 'linear'] as const satisfies readonly EasingName[];
export const SKYLINE_COLOR_MODES = ['skyline', 'theme'] as const satisfies readonly SkylineColorMode[];
