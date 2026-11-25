export interface Variant {
  frag: string;
  /** Fallback when WebGL2 is missing. Time `t` and intro progress `i` (0..1). */
  draw2d(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, i: number): void;
}

const INTRO_SECONDS = 1.6;
const STATIC_TIME = 7;
const MAX_LONG_SIDE = 1280;
const MAX_DPR = 1.5;

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const easeInOut = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

type Draw = (t: number, intro: number) => void;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
}

function glRenderer(gl: WebGL2RenderingContext, frag: string): Draw | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const uRes = gl.getUniformLocation(prog, "uRes");
  const uTime = gl.getUniformLocation(prog, "uTime");
  const uIntro = gl.getUniformLocation(prog, "uIntro");
  return (t, intro) => {
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform2f(uRes, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(uTime, t);
    gl.uniform1f(uIntro, intro);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}

export function mountBackground(canvas: HTMLCanvasElement, variant: Variant): void {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const gl = canvas.getContext("webgl2", { powerPreference: "low-power", antialias: false, alpha: false });
  const glDraw = gl ? glRenderer(gl, variant.frag) : null;
  // A canvas that already gave out a webgl2 context cannot hand out a 2d one.
  const ctx2d = glDraw || gl ? null : canvas.getContext("2d", { alpha: false });
  const draw: Draw | null = glDraw ?? (ctx2d ? (t, i) => variant.draw2d(ctx2d, canvas.width, canvas.height, t, i) : null);
  if (!draw) return;

  let time = 0;
  let visible = true;
  let raf = 0;
  let last = 0;

  const frame = (): void => draw(time, easeInOut(Math.min(1, time / INTRO_SECONDS)));
  const still = (): void => draw(STATIC_TIME, 1);

  const resize = (): void => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const scale = Math.min(window.devicePixelRatio || 1, MAX_DPR, MAX_LONG_SIDE / Math.max(r.width, r.height));
    canvas.width = Math.max(1, Math.round(r.width * scale));
    canvas.height = Math.max(1, Math.round(r.height * scale));
    if (reduced.matches) still();
    else frame();
  };

  const tick = (now: number): void => {
    // Clamp dt so a stalled frame does not skip the opening.
    time += Math.min(now - last, 50) / 1000;
    last = now;
    frame();
    raf = requestAnimationFrame(tick);
  };

  const sync = (): void => {
    const run = visible && !document.hidden && !reduced.matches;
    if (run && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    } else if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1]?.isIntersecting ?? true;
    sync();
  }).observe(canvas);
  document.addEventListener("visibilitychange", sync);
  reduced.addEventListener("change", () => {
    if (reduced.matches) still();
    sync();
  });
  new ResizeObserver(resize).observe(canvas);
  resize();
  sync();
}
