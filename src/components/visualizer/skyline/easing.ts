// src/components/visualizer/skyline/easing.ts
// 换句缓动曲线：主歌词（CSS）和两侧词云（JS）共用同一条。

/**
 * 换句缓动曲线：主歌词（CSS transition）和两侧词云（JS）共用同一条曲线，
 * 保证整块屏幕一起动。每个预设同时提供 JS 函数和等价的 CSS 字符串。
 */
export type EasingName = 'smooth' | 'out' | 'swift' | 'spring' | 'linear';

export const EASING_LABELS: Record<EasingName, string> = {
    smooth: '柔和（默认）：静止起步、短加速、长减速',
    out: '缓出：一开始最快',
    swift: '快速缓出',
    spring: '弹簧（轻微回弹）',
    linear: '线性',
};

export interface Easing {
    fn: (u: number) => number;
    css: string;
}

/** 三次贝塞尔求解（与浏览器 cubic-bezier 一致） */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (u: number) => number {
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
    const sy = (t: number) => ((ay * t + by) * t + cy) * t;
    const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
    return (x: number) => {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        let t = x;
        for (let i = 0; i < 8; i++) {
            const err = sx(t) - x;
            if (Math.abs(err) < 1e-6) break;
            const d = dx(t);
            if (Math.abs(d) < 1e-6) break;
            t -= err / d;
        }
        // 牛顿法不收敛时用二分兜底
        if (Math.abs(sx(t) - x) > 1e-4) {
            let lo = 0;
            let hi = 1;
            t = x;
            for (let i = 0; i < 30; i++) {
                if (sx(t) < x) lo = t;
                else hi = t;
                t = (lo + hi) / 2;
            }
        }
        return sy(t);
    };
}

/** 欠阻尼弹簧，u=1 时已基本静止，约 4% 回弹 */
function spring(u: number): number {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    const zeta = 0.72;
    const omega = 9.5;
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const e = Math.exp(-zeta * omega * u);
    return 1 - e * (Math.cos(wd * u) + ((zeta * omega) / wd) * Math.sin(wd * u));
}

/** 把任意函数采样成 CSS linear() */
function toCssLinear(fn: (u: number) => number, samples = 40): string {
    const pts: string[] = [];
    for (let i = 0; i <= samples; i++) pts.push((Math.round(fn(i / samples) * 1000) / 1000).toString());
    return `linear(${pts.join(', ')})`;
}

const supportsLinear = typeof CSS !== 'undefined' && CSS.supports('transition-timing-function', 'linear(0, 1)');

export const EASINGS: Record<EasingName, Easing> = {
    // 与原视频一致：从静止起步，约 0.1 秒内加速到最快，然后柔和地停住
    smooth: { fn: cubicBezier(0.3, 0, 0, 1), css: 'cubic-bezier(0.3, 0, 0, 1)' },
    out: { fn: cubicBezier(0.2, 0.8, 0.2, 1), css: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    swift: { fn: cubicBezier(0.16, 1, 0.3, 1), css: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    spring: {
        fn: spring,
        // 不支持 linear() 的浏览器退回到接近的贝塞尔
        css: supportsLinear ? toCssLinear(spring) : 'cubic-bezier(0.25, 1.15, 0.4, 1)',
    },
    linear: { fn: (u) => Math.min(1, Math.max(0, u)), css: 'linear' },
};
