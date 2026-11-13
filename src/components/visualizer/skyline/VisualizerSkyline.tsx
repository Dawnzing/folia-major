import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { resolveThemeFontStack, resolveThemeFontWeight } from '../../../utils/fontStacks';
import { getLineRenderEndTime } from '../../../utils/lyrics/renderHints';
import { DEFAULT_SUBTITLE_OVERLAY_LAYOUT, withSubtitleOverlayUpcomingPreview } from '../../../utils/lyrics/subtitleOverlayLayout';
import type { VisualizerSharedProps } from '../definition';
import { useLyricRenderQuality } from '../renderQuality/useLyricRenderQuality';
import { useVisualizerRuntime } from '../runtime';
import VisualizerShell from '../VisualizerShell';
import VisualizerSubtitleOverlay from '../VisualizerSubtitleOverlay';
import { resolveSubtitleFontSizes } from '../subtitleFontSizes';
import { SkylineEngine } from './skylineEngine';
import { fromFoliaLines } from './skylineLyrics';
import skylineTuning from './tuning';
import { SKYLINE_FONT_STACK, SKYLINE_FONT_STACK_JA } from './types';

// src/components/visualizer/skyline/VisualizerSkyline.tsx
// 天际的 React 外壳：把不依赖 React 的 SkylineEngine 挂进共享外壳，用自己的 RAF 循环读 currentTime 驱动它。
// React 只负责挂载和离散输入（歌词、主题、字体、tuning），逐帧的时间和音频能量不进 state。

/**
 * 音频能量统一到 0～1：主播放器 / OBS 给的是 0～255（audioPower、audioBands.bass），
 * 预览时钟和引擎内部按 0～1 计算（与 sonnetShotMg.ts 同一写法）。
 */
const normalizeAudioLevel = (value: number) => Math.min(1, Math.max(0, value > 1 ? value / 255 : value));

const VisualizerSkyline: React.FC<VisualizerSharedProps> = ({
    currentTime,
    currentLineIndex,
    lines,
    theme,
    subtitleTheme,
    audioPower,
    audioBands,
    paused = false,
    showText = true,
    isDaylight = false,
    lyricsFontScale = 1,
    subtitleFontScale = 1,
    subtitleOverlayOpacity,
    subtitleOverlayBackground,
    subtitleUpcomingLyricsBlur,
    isPlayerChromeHidden = false,
    hideTranslationSubtitle = false,
    subtitleOverlayLayout,
    isPreviewMode = false,
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
    // 词云画布的全局分辨率挡位（天际没有自己的一份覆盖）。预览格子用原始密度，不额外超采样
    const renderQuality = useLyricRenderQuality();
    const renderScale = isPreviewMode ? 1 : renderQuality.scale;

    // 底部字幕（译文 / 下一句）与其他样式共用同一套运行时与字号
    const { activeLine, recentCompletedLine, nextLines } = useVisualizerRuntime({
        currentTime,
        currentLineIndex,
        lines,
        getLineEndTime: getLineRenderEndTime,
    });
    const { translationFontSize, upcomingFontSize } = resolveSubtitleFontSizes(lyricsFontScale);
    // 天际自己在主歌词下方就预告下一句：字幕行在这一句上没东西可显示（没有译文）时，不再用后面几句顶替，
    // 否则下一句会出现两遍。用户在布局里明确选的行（含「下一句」）照常显示
    const subtitleLayout = withSubtitleOverlayUpcomingPreview(subtitleOverlayLayout ?? DEFAULT_SUBTITLE_OVERLAY_LAYOUT, false);

    // 逐帧循环读的输入放在 ref 里：MotionValue 换了对象（换歌交接）也不用重建引擎
    const live = useRef({ currentTime, audioPower, audioBands, paused, showText });
    // 挂载时要用的离散输入的最新值
    const initial = useRef({
        effectiveTuning, fontStack, fontStackJa, fontWeight, skyLines, songTitle, songArtist, theme, preview: isPreviewMode, renderScale,
    });
    useLayoutEffect(() => {
        live.current = { currentTime, audioPower, audioBands, paused, showText };
        initial.current = {
            effectiveTuning, fontStack, fontStackJa, fontWeight, skyLines, songTitle, songArtist, theme, preview: isPreviewMode, renderScale,
        };
    });

    // 挂载引擎与逐帧循环：只挂一次，之后的变化由下面几个 effect 送进去
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const init = initial.current;
        const engine = new SkylineEngine(host, init.effectiveTuning, init.fontStack, init.fontWeight, init.fontStackJa, {
            preview: init.preview,
            renderScale: init.renderScale,
        });
        engine.setThemeColors(init.theme.accentColor, init.theme.primaryColor, true);
        engine.setLines(init.skyLines, init.songTitle, init.songArtist);
        engineRef.current = engine;
        let raf = 0;
        let last = performance.now();
        const tick = (now: number) => {
            const dt = (now - last) / 1000;
            last = now;
            const v = live.current;
            // 宿主隐藏歌词时整个 frame 跳过（不更新、不画）；恢复时由下面的 effect 补画一帧
            if (v.showText) {
                engine.frame(v.currentTime.get(), dt, !v.paused, {
                    energy: normalizeAudioLevel(v.audioPower.get()),
                    bass: normalizeAudioLevel(v.audioBands.bass.get()),
                });
            }
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

    useEffect(() => {
        engineRef.current?.setRenderScale(renderScale);
    }, [renderScale]);

    useEffect(() => {
        // 从隐藏恢复：立即按当前时间补画一帧（隐藏期间引擎没跑）
        if (showText) engineRef.current?.invalidate();
    }, [showText]);

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
            <VisualizerSubtitleOverlay
                showText={showText}
                activeLine={activeLine}
                recentCompletedLine={recentCompletedLine}
                nextLines={nextLines}
                theme={theme}
                subtitleTheme={subtitleTheme}
                translationFontSize={translationFontSize}
                upcomingFontSize={upcomingFontSize}
                subtitleOverlayOpacity={subtitleOverlayOpacity}
                subtitleOverlayBackground={subtitleOverlayBackground}
                subtitleUpcomingLyricsBlur={subtitleUpcomingLyricsBlur}
                subtitleFontScale={subtitleFontScale}
                isPlayerChromeHidden={isPlayerChromeHidden}
                hideTranslationSubtitle={hideTranslationSubtitle}
                subtitleOverlayLayout={subtitleLayout}
            />
        </VisualizerShell>
    );
};

export default VisualizerSkyline;
