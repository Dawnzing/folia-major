import { get2dContext } from './spriteCache';
// src/components/visualizer/skyline/sparks.ts
// 演唱位置上方的闪烁粒子尾迹，画在词云同一块画布上。

/**
 * 演唱位置上方的闪烁粒子尾迹（Canvas 2D，叠加混合）。
 * 自己不持有画布：画到两侧词云的同一块画布上，少一个铺满全屏的图层，减轻 GPU 合成压力。
 * 粒子在填色边缘附近生成，向左上方缓慢漂移、闪烁、消失，形成跟随演唱进度的"彗尾"。
 * 尺寸参数都以当前字号 em 为单位，所以随长条缩放自动适配。
 */
export interface SparkParams {
    /** 每秒生成数量 */
    rate: number;
    life: [number, number];
    /** 生成位置：在填色边缘左侧多大范围内（em） */
    spread: number;
    /** 生成高度：文字顶部上方范围（em） */
    rise: [number, number];
    /** 水平速度（em/s，负数向左） */
    vx: [number, number];
    /** 竖直速度（em/s，负数向上） */
    vy: [number, number];
    /** 粒子半径（em） */
    size: [number, number];
    /** 必须是 6 位十六进制（贴图里会拼接透明度） */
    colors: string[];
}

export const defaultSparkParams: SparkParams = {
    rate: 95,
    life: [0.45, 1.25],
    spread: 1.6,
    rise: [0.0, 0.32],
    vx: [-0.5, -0.05],
    vy: [-0.22, -0.02],
    size: [0.018, 0.045],
    colors: ['#fff7dc', '#ffe39a', '#eaffc4', '#ffffff'],
};

interface Spark {
    x: number;
    y: number;
    vx: number;
    vy: number;
    age: number;
    life: number;
    r: number;
    phase: number;
    freq: number;
    sprite: HTMLCanvasElement;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const MAX = 400;
/** 累计发射量最多欠这么多：掉帧、高频或高分贝时不要一口气补发历史粒子 */
const MAX_CARRY = 32;

export class Sparks {
    params: SparkParams = structuredClone(defaultSparkParams);
    private readonly sparks: Spark[] = [];
    private sprites: HTMLCanvasElement[] = [];
    private carry = 0;
    /** 律动输入：energy 调生成速率，onset 时额外爆发一簇 */
    pulse = { energy: 0.5, beat: 0, onset: false, strength: 1 };
    private time = 0;

    constructor() {
        this.buildSprites();
    }

    setColors(colors: string[]): void {
        this.params.colors = colors;
        this.buildSprites();
    }

    /** 换歌 / 跳转：清掉尾迹、累计发射量和内部时间，不把旧歌的粒子带过来 */
    reset(): void {
        this.sparks.length = 0;
        this.carry = 0;
        this.time = 0;
    }

    /**
     * @param head 演唱位置（CSS px），null 表示当前没有在唱
     * @param dt 本帧推进秒数，暂停时为 0
     */
    update(dt: number, head: { x: number; y: number; em: number } | null): void {
        this.time += dt;
        const p = this.params;

        if (head && dt > 0) {
            const { energy, beat, onset, strength } = this.pulse;
            const rateMul = 1 + (0.45 + 1.1 * energy - 1) * strength;
            // 粒子已满额就不再积欠：否则恢复播放或降帧后会突然补发一大簇
            if (this.sparks.length < MAX) {
                this.carry = Math.min(MAX_CARRY, this.carry + p.rate * rateMul * dt + (onset ? 14 * beat * strength : 0));
            } else {
                this.carry = 0;
            }
            while (this.carry >= 1 && this.sparks.length < MAX) {
                this.carry -= 1;
                const em = head.em;
                // 越靠近填色边缘越密
                const back = Math.pow(Math.random(), 1.8) * p.spread * em;
                this.sparks.push({
                    x: head.x - back + rand(-0.08, 0.12) * em,
                    y: head.y - rand(p.rise[0], p.rise[1]) * em,
                    vx: rand(p.vx[0], p.vx[1]) * em,
                    vy: rand(p.vy[0], p.vy[1]) * em,
                    age: 0,
                    life: rand(p.life[0], p.life[1]),
                    r: rand(p.size[0], p.size[1]) * em,
                    phase: Math.random() * Math.PI * 2,
                    freq: rand(9, 22),
                    sprite: this.sprites[Math.floor(Math.random() * this.sprites.length)],
                });
            }
        } else if (!head) {
            this.carry = 0;
        }

        for (let i = this.sparks.length - 1; i >= 0; i--) {
            const s = this.sparks[i];
            s.age += dt;
            if (s.age >= s.life) {
                this.sparks.splice(i, 1);
                continue;
            }
            s.x += s.vx * dt;
            s.y += s.vy * dt;
        }

    }

    /**
     * 画到给定画布上（坐标单位为 CSS px × dpr），返回画过的区域，供调用方下一帧只清除这一块。
     */
    render(ctx: CanvasRenderingContext2D, dpr: number): [number, number, number, number] | null {
        if (!this.sparks.length) return null;
        let bx0 = Infinity;
        let by0 = Infinity;
        let bx1 = -Infinity;
        let by1 = -Infinity;
        ctx.globalCompositeOperation = 'lighter';
        for (const s of this.sparks) {
            const k = s.age / s.life;
            // 快速出现、缓慢消失，叠加高频闪烁
            const env = Math.min(1, k * 8) * (1 - k) * (1 - k);
            const twinkle = 0.55 + 0.45 * Math.sin(s.phase + this.time * s.freq);
            const a = env * twinkle;
            if (a < 0.02) continue;
            const size = s.r * 6 * dpr; // 贴图含光晕，实际亮核约 1/3
            const x = s.x * dpr - size / 2;
            const y = s.y * dpr - size / 2;
            ctx.globalAlpha = a;
            ctx.drawImage(s.sprite, x, y, size, size);
            if (x < bx0) bx0 = x;
            if (y < by0) by0 = y;
            if (x + size > bx1) bx1 = x + size;
            if (y + size > by1) by1 = y + size;
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        return bx1 > bx0 ? [Math.floor(bx0) - 2, Math.floor(by0) - 2, Math.ceil(bx1) + 2, Math.ceil(by1) + 2] : null;
    }

    /** 每种颜色一张带光晕的圆点贴图 */
    private buildSprites(): void {
        this.sprites = this.params.colors.map((color) => {
            const c = document.createElement('canvas');
            c.width = c.height = 48;
            const g = get2dContext(c);
            const grad = g.createRadialGradient(24, 24, 0, 24, 24, 24);
            grad.addColorStop(0, '#ffffff');
            grad.addColorStop(0.12, '#ffffff');
            grad.addColorStop(0.2, color);
            grad.addColorStop(0.32, color + '44');
            grad.addColorStop(1, color + '00');
            g.fillStyle = grad;
            g.fillRect(0, 0, 48, 48);
            return c;
        });
        for (const s of this.sparks) s.sprite = this.sprites[Math.floor(Math.random() * this.sprites.length)];
    }
}
