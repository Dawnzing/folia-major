import React from 'react';
import { Group, Row, Segmented, type SettingsGroupDef } from '../../modal/settings/kit';
import type { VisualizerSettingsPanelProps } from '../definition';
import { SliderRow, ToggleRow } from '../panelRows';
import { SKYLINE_RANGES, type SkylineColorMode, type SkylineFontMode, type SkylineTuning } from './types';
import type { EasingName } from './easing';

// src/components/visualizer/skyline/SkylineSettingsPanel.tsx
// 天际的参数面板：主歌词、换句动画、两侧词云、粒子与律动、颜色几组；滑块遵循草稿 / 松手提交语义。

type NumberKey = keyof typeof SKYLINE_RANGES;

const LYRIC_GROUP: SettingsGroupDef = { id: 'vis-skyline-lyric', titleKey: 'options.skylineLyricSection' };
const MOTION_GROUP: SettingsGroupDef = { id: 'vis-skyline-motion', titleKey: 'options.skylineMotionSection' };
const FIELD_GROUP: SettingsGroupDef = { id: 'vis-skyline-field', titleKey: 'options.skylineFieldSection' };
const SPARK_GROUP: SettingsGroupDef = { id: 'vis-skyline-spark', titleKey: 'options.skylineSparkSection' };
const COLOR_GROUP: SettingsGroupDef = { id: 'vis-skyline-color', titleKey: 'options.skylineColorSection' };

const LYRIC_SLIDERS: NumberKey[] = ['lyricScale', 'maxWidthRatio', 'grow', 'fadeWidth', 'float', 'lead', 'interludeMin'];
const MOTION_SLIDERS: NumberKey[] = ['duration', 'driftShare'];
const FIELD_SLIDERS: NumberKey[] = ['perSideMin', 'perSideMax', 'wordSize', 'spread', 'blurStrength', 'motionBlur', 'farDim'];
const SPARK_SLIDERS: NumberKey[] = ['sparkRate', 'reactStrength'];

/** 参数名 → 文案键：options.skyline + 首字母大写的参数名 */
const labelKey = (key: string) => `options.skyline${key[0].toUpperCase()}${key.slice(1)}`;

const EASING_OPTIONS: EasingName[] = ['smooth', 'out', 'swift', 'spring', 'linear'];

const SkylineSettingsPanel: React.FC<VisualizerSettingsPanelProps<SkylineTuning>> = ({
    t,
    tuning,
    onTuningChange,
    onSliderPointerDown,
    onSliderCommit,
}) => {
    const slider = (key: NumberKey) => {
        const range = SKYLINE_RANGES[key];
        return (
            <SliderRow
                key={key}
                label={t(labelKey(key))}
                value={tuning[key]}
                min={range.min}
                max={range.max}
                step={range.step}
                format={range.integer ? (v: number) => String(Math.round(v)) : (v: number) => v.toFixed(2)}
                onChange={(value: number) => onTuningChange({ [key]: range.integer ? Math.round(value) : value })}
                onDragStart={onSliderPointerDown}
                onDragEnd={onSliderCommit}
            />
        );
    };

    return (
        <>
            <Group def={LYRIC_GROUP}>
                <Row label={t('options.skylineFontMode')}>
                    <Segmented<SkylineFontMode>
                        value={tuning.fontMode}
                        options={[
                            { value: 'skyline', label: t('options.skylineFontModeSkyline') },
                            { value: 'theme', label: t('options.skylineFontModeTheme') },
                        ]}
                        onChange={fontMode => onTuningChange({ fontMode })}
                    />
                </Row>
                {LYRIC_SLIDERS.map(slider)}
                <ToggleRow
                    label={t('options.skylineEmphasize')}
                    note={t('options.skylineEmphasizeHint')}
                    checked={tuning.emphasize}
                    onChange={(emphasize: boolean) => onTuningChange({ emphasize })}
                />
            </Group>

            <Group def={MOTION_GROUP}>
                <Row label={t('options.skylineEasing')}>
                    <Segmented<EasingName>
                        value={tuning.easing}
                        options={EASING_OPTIONS.map(value => ({ value, label: t(`options.skylineEasing${value[0].toUpperCase()}${value.slice(1)}`) }))}
                        onChange={easing => onTuningChange({ easing })}
                    />
                </Row>
                {MOTION_SLIDERS.map(slider)}
            </Group>

            <Group def={FIELD_GROUP}>
                {FIELD_SLIDERS.map(slider)}
            </Group>

            <Group def={SPARK_GROUP}>
                {SPARK_SLIDERS.map(slider)}
            </Group>

            <Group def={COLOR_GROUP}>
                <Row label={t('options.skylineColorMode')}>
                    <Segmented<SkylineColorMode>
                        value={tuning.colorMode}
                        options={[
                            { value: 'skyline', label: t('options.skylineColorModeSkyline') },
                            { value: 'theme', label: t('options.skylineColorModeTheme') },
                        ]}
                        onChange={colorMode => onTuningChange({ colorMode })}
                    />
                </Row>
                {slider('glow')}
            </Group>
        </>
    );
};

export default SkylineSettingsPanel;
