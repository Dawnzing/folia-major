import React from 'react';
import { Sparkles } from 'lucide-react';
import { QuickControlToggle } from '../../shared/QuickControlChip';
import { defineVisualizer, type VisualizerQuickControlsProps } from '../definition';
import SkylineSettingsPanel from './SkylineSettingsPanel';
import type { SkylineTuning } from './types';

const VisualizerSkyline = React.lazy(() => import('./VisualizerSkyline'));

// src/components/visualizer/skyline/entry.tsx
// Registers 天际: 车载天际屏风格的歌词——中间逐字填色的当前句，两侧随换句推进的 3D 词云。
export default defineVisualizer({
    mode: 'skyline',
    order: 135,
    labelKey: 'ui.visualizerSkyline',
    labelFallback: '天际',
    previewSeed: 'skyline',
    previewStartOffset: 0,
    // 天际：中间一行，两侧散落的小词
    glyph: (
        <>
            <path d="M8 12h8" />
            <path d="M2.5 9.5h3M3.5 14.5h2.5M18 9.5h3.5M18.5 14.5h2" opacity="0.45" />
        </>
    ),
    command: {
        title: 'Visualizer: Skyline',
        description: 'Switch to the Skyline visualizer',
        keywords: ['skyline', '天际', '天际屏', '车载', 'karaoke', '词云'],
    },
    // 两侧的词来自整句分词：用户保存的切分会改变画面
    usesWordSegmentation: true,
    // 原效果是纯黑底：不画共用背景（样式自己画黑底和主题色光晕）
    background: false,
    render: props => <VisualizerSkyline {...props} />,
    renderSettingsPanel: props => <SkylineSettingsPanel {...props} />,
    renderQuickControls: ({ tuning, onTuningChange, t }: VisualizerQuickControlsProps<SkylineTuning>) => (
        <QuickControlToggle
            active={tuning.colorMode === 'theme'}
            label={t('options.skylineColorModeTheme')}
            onToggle={() => onTuningChange({ colorMode: tuning.colorMode === 'theme' ? 'skyline' : 'theme' })}
        >
            <Sparkles size={14} />
        </QuickControlToggle>
    ),
});
