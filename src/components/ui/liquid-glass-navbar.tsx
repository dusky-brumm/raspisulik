'use client';

/**
 * Adapted from Nimbus UI · Waterline by guglielmogiannattasio.it, supplied by the user.
 * The water now follows both axes for sidebar and wrapped navigation layouts.
 */
import * as React from 'react';
import { FRAG, VERT } from './liquid-glass-shaders';
import './liquid-glass-navbar.css';

export type NimbusFx = 'plane' | 'drop' | 'spin' | 'glow' | 'wave' | 'pop' | 'none';
export type LiquidNavItem = {
  label: string;
  href?: string;
  icon?: React.ReactNode;
  fx?: NimbusFx;
};
export type LiquidNavbarProps = {
  items: LiquidNavItem[];
  defaultActive?: number;
  active?: number;
  onChange?: (index: number, item: LiquidNavItem) => void;
  tone?: 'light' | 'dark';
  compact?: boolean;
  sound?: boolean;
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
};

const PAD = 14;
type Body = { x: number; y: number; vx: number; vy: number };
type Satellite = Body & { r: number; k: number };
type Ripple = { x: number; y: number; age: number; amp: number };

function initGL(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) return null;
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  const dispose = () => {
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    shaders.forEach((shader) => gl.deleteShader(shader));
  };
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, VERT],
      [gl.FRAGMENT_SHADER, FRAG],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Shader unavailable');
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Shader unsupported');
    }
    program = gl.createProgram();
    buffer = gl.createBuffer();
    if (!program || !buffer) throw new Error('Renderer unavailable');
    shaders.forEach((shader) => gl.attachShader(program!, shader));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Renderer unsupported');
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    for (const name of [
      'uRes',
      'uRadius',
      'uDpr',
      'uTime',
      'uPill',
      'uBlob',
      'uSy',
      'uRip',
      'uMouse',
      'uDark',
      'uAmb',
    ])
      uniforms[name] = gl.getUniformLocation(program, name);
    return {
      gl,
      uniforms,
      dispose,
      blobs: new Float32Array(24),
      scales: new Float32Array(6),
      ripples: new Float32Array(24),
    };
  } catch {
    dispose();
    return null;
  }
}

function makeState() {
  return {
    a: { x: 0, y: 0, vx: 0, vy: 0 } as Body,
    b: { x: 0, y: 0, vx: 0, vy: 0 } as Body,
    target: { x: 0, y: 0, q: 0, r: 22 },
    q: 0,
    sy: { value: 1, velocity: 0 },
    lead: 0,
    lagUntil: 0,
    satellites: [] as Satellite[],
    ripples: [] as Ripple[],
    mouse: { x: 0, y: 0, strength: 0, on: false },
    width: 0,
    height: 0,
    radius: 28,
    moving: false,
    split: false,
    ready: false,
    inView: true,
    reduce: false,
    raf: 0,
    last: 0,
    time: 0,
    renderer: null as ReturnType<typeof initGL>,
  };
}

export function LiquidNavbar({
  items,
  defaultActive = 0,
  active,
  onChange,
  tone = 'light',
  compact = false,
  sound = false,
  className,
  style,
  ariaLabel = 'Основная навигация',
}: LiquidNavbarProps) {
  const [inner, setInner] = React.useState(defaultActive);
  const current = Math.max(0, Math.min(active ?? inner, items.length - 1));
  const navRef = React.useRef<HTMLElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const dropRef = React.useRef<HTMLSpanElement>(null);
  const itemRefs = React.useRef<(HTMLElement | null)[]>([]);
  const state = React.useRef(makeState());
  const [webgl, setWebgl] = React.useState(false);
  const [refract, setRefract] = React.useState(false);
  const [fx, setFx] = React.useState({ index: -1, version: 0 });
  const audioRef = React.useRef<AudioContext | null>(null);
  const timers = React.useRef(new Set<ReturnType<typeof setTimeout>>());
  const filterId = `nimbus-refraction-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const darkRef = React.useRef(tone === 'dark' ? 1 : 0);
  darkRef.current = tone === 'dark' ? 1 : 0;

  const draw = React.useCallback(() => {
    const s = state.current,
      t = s.target;
    const separation = Math.hypot(s.a.x - s.b.x, s.a.y - s.b.y);
    const thin = Math.min(separation / (2 * (s.q + t.r) || 1), 1);
    if (s.renderer) {
      const { gl, uniforms: u, blobs, scales, ripples } = s.renderer;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform2f(u.uRes, s.width + PAD * 2, s.height + PAD * 2);
      gl.uniform1f(u.uRadius, s.radius);
      gl.uniform1f(u.uDpr, dpr);
      gl.uniform1f(u.uTime, s.time);
      gl.uniform4f(u.uPill, PAD, PAD, s.width, s.height);
      const head = s.lead === 0 ? s.a : s.b,
        tail = s.lead === 0 ? s.b : s.a;
      blobs.fill(0);
      scales.fill(1);
      ripples.fill(0);
      blobs.set([
        head.x,
        head.y,
        s.q * (1 - 0.25 * thin),
        t.r * (1 - 0.12 * thin),
        tail.x,
        tail.y,
        s.q * (1 - 0.8 * thin),
        t.r * (1 - 0.5 * thin),
      ]);
      scales[0] = scales[1] = s.sy.value;
      s.satellites.slice(0, 4).forEach((d, i) => blobs.set([d.x, d.y, 0, d.r], 8 + i * 4));
      s.ripples.slice(-6).forEach((r, i) => ripples.set([r.x, r.y, r.age, r.amp], i * 4));
      gl.uniform4fv(u.uBlob, blobs);
      gl.uniform1fv(u.uSy, scales);
      gl.uniform4fv(u.uRip, ripples);
      gl.uniform3f(u.uMouse, s.mouse.x, s.mouse.y, s.mouse.strength);
      gl.uniform1f(u.uDark, darkRef.current);
      gl.uniform1f(u.uAmb, s.reduce ? 0 : 1);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else if (dropRef.current) {
      const radius = t.r * (1 - 0.3 * thin);
      const x = Math.min(s.a.x, s.b.x) - s.q - radius - PAD;
      const y = Math.min(s.a.y, s.b.y) - radius - PAD;
      dropRef.current.style.width = `${Math.abs(s.a.x - s.b.x) + 2 * (s.q + radius)}px`;
      dropRef.current.style.height = `${Math.abs(s.a.y - s.b.y) + 2 * radius}px`;
      dropRef.current.style.transform = `translate(${x}px, ${y}px) scaleY(${s.sy.value})`;
    }
  }, []);

  const step = React.useCallback((dt: number, now: number) => {
    const s = state.current,
      t = s.target;
    s.time += dt;
    let still = true;
    if (s.reduce) {
      for (const body of [s.a, s.b]) Object.assign(body, { x: t.x, y: t.y, vx: 0, vy: 0 });
      s.q = t.q;
      s.sy.value = 1;
      s.sy.velocity = 0;
      s.satellites = [];
      s.ripples = [];
      s.mouse.strength = 0;
    } else {
      s.q += (t.q - s.q) * Math.min(1, dt * 12);
      [s.a, s.b].forEach((body, i) => {
        const lead = i === s.lead,
          spring = lead ? 210 : 72,
          damping = lead ? 25 : 13;
        const lag = !lead && now < s.lagUntil ? 0.08 : 1;
        body.vx += (spring * (t.x - body.x) - damping * body.vx) * dt * lag;
        body.vy += (spring * (t.y - body.y) - damping * body.vy) * dt * lag;
        body.x += body.vx * dt;
        body.y += body.vy * dt;
        body.x = Math.max(PAD + s.q + t.r + 3, Math.min(PAD + s.width - s.q - t.r - 3, body.x));
        body.y = Math.max(PAD + t.r + 3, Math.min(PAD + s.height - t.r - 3, body.y));
        if (Math.hypot(t.x - body.x, t.y - body.y) > 0.3 || Math.hypot(body.vx, body.vy) > 3) still = false;
      });
      const lead = s.lead === 0 ? s.a : s.b;
      const scale = 1 - 0.2 * Math.min(Math.hypot(lead.vx, lead.vy) / 1500, 1);
      s.sy.velocity += (280 * (scale - s.sy.value) - 9 * s.sy.velocity) * dt;
      s.sy.value += s.sy.velocity * dt;
      if (Math.abs(s.sy.value - 1) > 0.002 || Math.abs(s.sy.velocity) > 0.02) still = false;
      if (!s.split && s.moving && Math.hypot(s.a.x - s.b.x, s.a.y - s.b.y) > 2 * (t.q + t.r) - 6) {
        s.split = true;
        const tail = s.lead === 0 ? s.b : s.a;
        [0.3, 0.5, 0.72].forEach((fraction, i) =>
          s.satellites.push({
            x: tail.x + (lead.x - tail.x) * fraction,
            y: tail.y + (lead.y - tail.y) * fraction,
            vx: (tail.vx + lead.vx) * 0.45,
            vy: (tail.vy + lead.vy) * 0.45,
            r: 6 - i * 0.5,
            k: 100 + i * 30,
          }),
        );
      }
      s.satellites = s.satellites.filter((d) => {
        d.vx += (d.k * (t.x - d.x) - 9 * d.vx) * dt;
        d.vy += (d.k * (t.y - d.y) - 9 * d.vy) * dt;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        d.x = Math.max(PAD + d.r + 4, Math.min(PAD + s.width - d.r - 4, d.x));
        d.y = Math.max(PAD + d.r + 4, Math.min(PAD + s.height - d.r - 4, d.y));
        if (Math.hypot(t.x - d.x, t.y - d.y) < t.r + t.q * 0.5) d.r -= dt * 26;
        return d.r > 0.6;
      });
      if (s.satellites.length) still = false;
      s.ripples.forEach((ripple) => (ripple.age += dt));
      s.ripples = s.ripples.filter((ripple) => ripple.age < 2.4);
      s.mouse.strength += ((s.mouse.on ? 1 : 0) - s.mouse.strength) * Math.min(1, dt * 7);
    }
    if (s.moving && still) {
      s.moving = false;
      if (!s.reduce) s.ripples.push({ x: t.x, y: t.y, age: 0, amp: 0.7 });
    }
  }, []);

  const loop = React.useCallback(() => {
    const s = state.current;
    if (s.raf || !s.ready || !s.inView || document.hidden) return;
    s.last = performance.now();
    const tick = (now: number) => {
      s.raf = 0;
      if (!s.inView || document.hidden) return;
      const interacting = s.moving || s.ripples.length || s.satellites.length || s.mouse.on;
      if (!s.reduce && !interacting && now - s.last < 1000 / 24) {
        s.raf = requestAnimationFrame(tick);
        return;
      }
      step(Math.min((now - s.last) / 1000, 1 / 30), now);
      s.last = now;
      draw();
      const busy =
        s.moving || s.ripples.length || s.satellites.length || (s.renderer && s.mouse.strength > 0.01);
      if ((s.renderer && !s.reduce) || busy) s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
  }, [draw, step]);

  const measure = React.useCallback(() => {
    const nav = navRef.current,
      item = itemRefs.current[current];
    if (!nav || !item) return;
    const s = state.current;
    s.width = nav.offsetWidth;
    s.height = nav.offsetHeight;
    s.radius = Math.min(
      parseFloat(getComputedStyle(nav).borderTopLeftRadius) || 28,
      s.width / 2,
      s.height / 2,
    );
    const x = PAD + item.offsetLeft + item.offsetWidth / 2;
    const y = PAD + item.offsetTop + item.offsetHeight / 2;
    s.target.q = Math.max(0, (item.offsetWidth - item.offsetHeight) / 2);
    s.target.r = item.offsetHeight / 2;
    if (!s.ready) {
      Object.assign(s.a, { x, y, vx: 0, vy: 0 });
      Object.assign(s.b, { x, y, vx: 0, vy: 0 });
      s.q = s.target.q;
      s.ready = true;
    } else if (Math.hypot(x - s.target.x, y - s.target.y) > 0.5) {
      s.lead = Math.hypot(x - s.a.x, y - s.a.y) <= Math.hypot(x - s.b.x, y - s.b.y) ? 0 : 1;
      s.lagUntil = performance.now() + 70;
      s.moving = true;
      s.split = false;
    }
    s.target.x = x;
    s.target.y = y;
    const canvas = canvasRef.current;
    if (canvas) {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5),
        width = s.width + PAD * 2,
        height = s.height + PAD * 2;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
    }
    draw();
    loop();
  }, [current, draw, loop]);
  const measureRef = React.useRef(measure);
  measureRef.current = measure;

  React.useEffect(() => {
    const s = state.current,
      canvas = canvasRef.current;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    s.reduce = preference.matches;
    s.renderer = canvas ? initGL(canvas) : null;
    setWebgl(Boolean(s.renderer));
    setRefract(
      /Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent) && CSS.supports('backdrop-filter', 'url(#a)'),
    );
    const lost = (event: Event) => {
      event.preventDefault();
      s.renderer?.dispose();
      s.renderer = null;
      setWebgl(false);
      draw();
      loop();
    };
    const reduced = () => {
      s.reduce = preference.matches;
      setFx({ index: -1, version: 0 });
      loop();
    };
    const visibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(s.raf);
        s.raf = 0;
      } else loop();
    };
    const observer = new IntersectionObserver(([entry]) => {
      s.inView = entry.isIntersecting;
      if (s.inView) loop();
      else {
        cancelAnimationFrame(s.raf);
        s.raf = 0;
      }
    });
    if (navRef.current) observer.observe(navRef.current);
    canvas?.addEventListener('webglcontextlost', lost);
    preference.addEventListener('change', reduced);
    document.addEventListener('visibilitychange', visibility);
    measureRef.current();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(s.raf);
      s.raf = 0;
      canvas?.removeEventListener('webglcontextlost', lost);
      preference.removeEventListener('change', reduced);
      document.removeEventListener('visibilitychange', visibility);
      s.renderer?.dispose();
      s.renderer = null;
      timers.current.forEach(clearTimeout);
      timers.current.clear();
      if (audioRef.current) {
        void audioRef.current.close().catch(() => {});
        audioRef.current = null;
      }
    };
  }, [draw, loop]);
  React.useLayoutEffect(() => {
    measure();
  }, [measure, items.length, compact]);
  React.useEffect(() => {
    const resize = new ResizeObserver(() => {
      state.current.ready = false;
      measureRef.current();
    });
    if (navRef.current) resize.observe(navRef.current);
    return () => resize.disconnect();
  }, []);
  React.useEffect(() => {
    draw();
    loop();
  }, [tone, draw, loop]);

  const local = (x: number, y: number) => {
    const rect = navRef.current!.getBoundingClientRect();
    return { x: x - rect.left + PAD, y: y - rect.top + PAD };
  };
  function ripple(x: number, y: number, amp: number) {
    const s = state.current;
    if (s.reduce || document.hidden) return;
    s.ripples.push({ x, y, age: 0, amp });
    loop();
  }
  function plip() {
    if (!sound) return;
    try {
      const Audio =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Audio) return;
      const context = (audioRef.current ??= new Audio());
      void context.resume().catch(() => {});
      const oscillator = context.createOscillator(),
        gain = context.createGain(),
        now = context.currentTime;
      oscillator.frequency.setValueAtTime(460, now);
      oscillator.frequency.exponentialRampToValueAtTime(1500, now + 0.07);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.04, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.18);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    } catch {
      /* Sound is optional and never prevents navigation. */
    }
  }
  function select(index: number) {
    const item = items[index];
    if (!item) return;
    if (!state.current.reduce) setFx((previous) => ({ index, version: previous.version + 1 }));
    plip();
    const element = itemRefs.current[index];
    if (element && item.fx === 'drop' && !state.current.reduce) {
      const rect = element.getBoundingClientRect(),
        point = local(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        ripple(point.x, point.y, 1.2);
      }, 430);
      timers.current.add(timer);
    }
    if (active === undefined) setInner(index);
    onChange?.(index, item);
  }
  function keyDown(event: React.KeyboardEvent) {
    const focused = itemRefs.current.findIndex((item) => item === document.activeElement);
    const base = focused < 0 ? current : focused;
    const columns =
      itemRefs.current.filter((item) => item && item.offsetTop === itemRefs.current[0]?.offsetTop).length ||
      1;
    const rows = new Set(itemRefs.current.filter(Boolean).map((item) => item!.offsetTop)).size;
    const offset = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: rows > 1 ? -columns : 0,
      ArrowDown: rows > 1 ? columns : 0,
    }[event.key];
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : offset
            ? (base + offset + items.length) % items.length
            : -1;
    if (next < 0) return;
    event.preventDefault();
    select(next);
    itemRefs.current[next]?.focus();
  }

  return (
    <nav
      ref={navRef}
      className={['nimbus-nav', className].filter(Boolean).join(' ')}
      aria-label={ariaLabel}
      data-tone={tone}
      data-gl={webgl ? 'on' : 'off'}
      data-compact={String(compact)}
      data-refract={refract ? 'on' : 'off'}
      onKeyDown={keyDown}
      onPointerMove={(event) => {
        if (event.pointerType !== 'mouse') return;
        Object.assign(state.current.mouse, local(event.clientX, event.clientY), { on: true });
        loop();
      }}
      onPointerLeave={() => {
        state.current.mouse.on = false;
        loop();
      }}
      onPointerDown={(event) => {
        const point = local(event.clientX, event.clientY);
        ripple(point.x, point.y, 0.8);
      }}
      style={{ ...style, '--n-refraction': `url(#${filterId})` } as React.CSSProperties}
    >
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <filter id={filterId} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.006 0.02"
            numOctaves="2"
            seed="7"
            result="noise"
          />
          <feGaussianBlur in="noise" stdDeviation="2" result="soft" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="soft"
            scale="60"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>
      <span className="nimbus-glass" aria-hidden="true" />
      <canvas className="nimbus-water" ref={canvasRef} aria-hidden="true" />
      <span className="nimbus-drop" ref={dropRef} aria-hidden="true" />
      {items.map((item, index) => {
        const kind = item.fx ?? 'pop',
          playing = fx.index === index && kind !== 'none';
        const props = {
          ref: (element: HTMLElement | null) => {
            itemRefs.current[index] = element;
          },
          className: 'nimbus-item',
          'aria-current': index === current ? ('page' as const) : undefined,
          'aria-label': item.label,
          onClick: () => select(index),
        };
        const content = (
          <>
            {item.icon && (
              <span className="nv-ico" key={playing ? fx.version : 0} data-fx={playing ? kind : undefined}>
                {item.icon}
              </span>
            )}
            <span className="nimbus-label">{item.label}</span>
          </>
        );
        return item.href ? (
          <a key={item.label} {...props} href={item.href}>
            {content}
          </a>
        ) : (
          <button key={item.label} {...props} type="button">
            {content}
          </button>
        );
      })}
    </nav>
  );
}

export { LiquidNavbar as Component };
export default LiquidNavbar;
