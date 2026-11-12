// src/components/visualizer/skyline/timedAnim.ts
// 由歌词时间驱动的 Web Animation，只用于整行的句内放大。

/**
 * 由歌词时间驱动的 Web Animation（只用于句内放大这一项）。
 *
 * 整行的缩放交给浏览器合成器运行：不用每帧重新栅格化整行文字，
 * 并且会按动画的最大尺寸栅格化，放大时文字不会糊。
 * 每帧检查动画进度是否与歌词时间一致，偏差超过阈值才校正，
 * 所以跳转、暂停、重播时状态仍与时间严格对应。
 *
 * 注意：不要给大量小元素各建一个（每个都会成为独立 GPU 图层）。
 */
export class TimedAnim {
    private readonly end: number;

    /**
     * @param anim 已创建的动画（会立即暂停，由 sync 驱动）
     * @param startAt 动画时间 0 对应的歌词时间（秒）
     */
    constructor(
        readonly anim: Animation,
        readonly startAt: number,
    ) {
        anim.pause();
        this.end = Number(anim.effect?.getComputedTiming().endTime ?? 0);
    }

    sync(t: number, playing: boolean): void {
        const a = this.anim;
        const want = (t - this.startAt) * 1000;
        const cur = typeof a.currentTime === 'number' ? a.currentTime : Number.NaN;
        if (!playing || want >= this.end) {
            // 暂停中或已经结束：停在对应进度（结束的停在终点，不要每帧重复设置）
            const target = Math.min(want, this.end);
            if (a.playState === 'running') a.pause();
            if (!(Math.abs(cur - target) < 0.5)) a.currentTime = target;
            return;
        }
        if (!(Math.abs(cur - want) < 30)) a.currentTime = want;
        if (a.playState !== 'running') a.play();
    }

    freeze(): void {
        if (this.anim.playState === 'running') this.anim.pause();
    }

    cancel(): void {
        this.anim.cancel();
    }
}
