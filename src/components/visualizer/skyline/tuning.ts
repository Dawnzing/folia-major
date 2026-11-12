import { defineVisualizerTuning, modChoice, modNumber, MOD_SWITCH, numberWithin, type VisualizerModTuningKey } from '../tuningDefinition';
import { DEFAULT_SKYLINE_TUNING, SKYLINE_COLOR_MODES, SKYLINE_EASINGS, SKYLINE_RANGES, type SkylineTuning } from './types';

// src/components/visualizer/skyline/tuning.ts
// 天际的 tuning：默认值、存在设置仓库的哪几个字段、存储键，以及读取和合并时的夹取。

declare module '../tuningDefinition' {
    // 设置仓库里天际的三个字段（与 StoredTuningFields<'skylineTuning', ...> 相同，写开以免空接口）
    interface VisualizerTuningSettings {
        skylineTuning: SkylineTuning;
        handleSetSkylineTuning: (patch: Partial<SkylineTuning>) => void;
        handleResetSkylineTuning: () => void;
    }
}

const NUMBER_KEYS = Object.keys(SKYLINE_RANGES) as (keyof typeof SKYLINE_RANGES)[];

/** values 里给出的值夹到范围内，没给的取 base 的；整数项取整。每侧最多小于最少时由引擎取较大者，这里不改写 */
const resolve = (values: Partial<SkylineTuning>, base: SkylineTuning): SkylineTuning => {
    const out: SkylineTuning = { ...base };
    for (const key of NUMBER_KEYS) {
        const { min, max, integer } = SKYLINE_RANGES[key];
        const v = numberWithin(values[key], base[key], min, max);
        out[key] = integer ? Math.round(v) : v;
    }
    if (typeof values.emphasize === 'boolean') out.emphasize = values.emphasize;
    const easing = SKYLINE_EASINGS.find(e => e === values.easing);
    if (easing) out.easing = easing;
    const colorMode = SKYLINE_COLOR_MODES.find(m => m === values.colorMode);
    if (colorMode) out.colorMode = colorMode;
    return out;
};

const modKeys: { [K in keyof SkylineTuning]?: VisualizerModTuningKey } = {
    emphasize: MOD_SWITCH,
    easing: modChoice(SKYLINE_EASINGS),
    colorMode: modChoice(SKYLINE_COLOR_MODES),
};
for (const key of NUMBER_KEYS) {
    const { min, max, integer } = SKYLINE_RANGES[key];
    modKeys[key] = integer ? modNumber(min, max, 1) : modNumber(min, max);
}

export default defineVisualizerTuning<SkylineTuning>({
    mode: 'skyline',
    defaults: DEFAULT_SKYLINE_TUNING,
    // 模组可读写的项（folium.visualizer.setTuning）：设置面板里的全部参数
    modKeys,
    settingsKey: 'skylineTuning',
    settingsSetterKey: 'handleSetSkylineTuning',
    settingsResetterKey: 'handleResetSkylineTuning',
    storage: {
        key: 'skyline_tuning',
        read: (stored: Partial<SkylineTuning>) => resolve(stored, DEFAULT_SKYLINE_TUNING),
        merge: (held, patch) => resolve(patch, held),
        resetNotice: 'notifications.skylineReset',
    },
});
