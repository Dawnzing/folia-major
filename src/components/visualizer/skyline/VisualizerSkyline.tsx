import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { resolveThemeFontStack, resolveThemeFontWeight } from '../../../utils/fontStacks';
import type { VisualizerSharedProps } from '../definition';
import VisualizerShell from '../VisualizerShell';
import { SkylineEngine } from './skylineEngine';
import { fromFoliaLines } from './skylineLyrics';
import skylineTuning from './tuning';
import { SKYLINE_FONT_STACK, SKYLINE_FONT_STACK_JA } from './types';

// src/components/visualizer/skyline/VisualizerSkyline.tsx
// 天际的 React 外壳：把不依赖 React 的 SkylineEngine 挂进共享外壳，用自己的 RAF 循环读 currentTime 驱动它。
// React 只负责挂载和离散输入（歌词、主题、字体、tuning），逐帧的时间和音频能量不进 state。

const VisualizerSkyline: React.FC<VisualizerSharedProps> = ({
    currentTime,
    lines,
    theme,
    audioPower,
    audioBands,
    paused = false,
    showText = true,
    isDaylight = false,
    lyricsFontScale = 1,
    songTitle,
    songArtist,
    visualizerTunings,
    ...sharedProps
}) => {
    const hostRef = useRef<HTMLDivElement>(null);
    const engineRef = useRef<SkylineEngine | null>(null);

    const tuning = skylineTuning.read(visualizerTunings);
    // 天际衬线是样式自己的字体（与原视频一致）；也可以改为跟随主题字体。字重始终走主题
    const themeStack = resolveThemeFontStack(theme);
    const fontStack = tuning.fontMode === 'theme' ? themeStack : SKYLINE_FONT_STACK;
    const fontStackJa = tuning.fontMode === 'theme' ? themeStack : SKYLINE_FONT_STACK_JA;
    const fontWeight = resolveThemeFontWeight(theme, 700);
    // 用户的歌词字号倍率乘在样式自己的字号倍率上
    const effectiveTuning = useMemo(() => ({ ...tuning, lyricScale: tuning.lyricScale * lyricsFontScale }), [tuning, lyricsFontScale]);
    const skyLines = useMemo(() => fromFoliaLines(lines), [lines]);

    // 逐帧循环读的输入放在 ref 里：MotionValue 换了对象（换歌交接）也不用重建引擎
    const live = useRef({ currentTime, audioPower, audioBands, paused });
    // 挂载时要用的离散输入的最新值
    const initial = useRef({ effectiveTuning, fontStack, fontStackJa, fontWeight, skyLines, songTitle, songArtist, theme });
    useLayoutEffect(() => {
        live.current = { currentTime, audioPower, audioBands, paused };
        initial.current = { effectiveTuning, fontStack, fontStackJa, fontWeight, skyLines, songTitle, songArtist, theme };
    });

    // 挂载引擎与逐帧循环：只挂一次，之后的变化由下面几个 effect 送进去
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const init = initial.current;
        const engine = new SkylineEngine(host, init.effectiveTuning, init.fontStack, init.fontWeight, init.fontStackJa);
        engine.setThemeColors(init.theme.accentColor, init.theme.primaryColor, true);
        engine.setLines(init.skyLines, init.songTitle, init.songArtist);
        engineRef.current = engine;
        let raf = 0;
        let last = performance.now();
        const tick = (now: number) => {
            const dt = (now - last) / 1000;
            last = now;
            const v = live.current;
            engine.frame(v.currentTime.get(), dt, !v.paused, {
                energy: v.audioPower.get(),
                bass: v.audioBands.bass.get(),
            });
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => {
            cancelAnimationFrame(raf);
            engine.dispose();
            engineRef.current = null;
        };
    }, []);

    useEffect(() => {
        engineRef.current?.setLines(skyLines, songTitle, songArtist);
    }, [skyLines, songTitle, songArtist]);

    useEffect(() => {
        // 跟随主题色时：强调色作已唱色，主色作未唱色
        engineRef.current?.setThemeColors(theme.accentColor, theme.primaryColor);
    }, [theme.accentColor, theme.primaryColor]);

    useEffect(() => {
        engineRef.current?.setFont(fontStack, fontWeight, fontStackJa);
    }, [fontStack, fontStackJa, fontWeight]);

    useEffect(() => {
        engineRef.current?.setTuning(effectiveTuning);
    }, [effectiveTuning]);

    return (
        <VisualizerShell
            theme={theme}
            audioPower={audioPower}
            audioBands={audioBands}
            sharedProps={{ ...sharedProps, isDaylight, paused }}
            renderBackground={false}
            className="visualizer-skyline"
        >
            <div
                ref={hostRef}
                className="absolute inset-0 pointer-events-none"
                style={{ opacity: showText ? 1 : 0 }}
            />
        </VisualizerShell>
    );
};

export default VisualizerSkyline;
