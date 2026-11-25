import type { Variant } from "./runtime";

const frag = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform float uTime, uIntro;
out vec4 o;

float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + 1.0), f.x), f.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float ar = uRes.x / uRes.y;
  vec3 col = vec3(0.027, 0.030, 0.045);
  vec3 blue = vec3(0.16, 0.36, 0.95), violet = vec3(0.46, 0.30, 0.95);
  float sweep = smoothstep(-0.25, 0.25, uIntro * 1.5 - 0.25 - abs(uv.x - 0.5) * 1.1);

  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float t = uTime * (0.035 + fi * 0.012);
    float x = uv.x * ar;
    // Slow vertical centre line of the curtain, then soft falloff around it.
    float c = 0.62 + 0.2 * (n(vec2(x * 0.7 + t * 3.0 + fi * 5.0, fi * 3.0)) - 0.5) - fi * 0.07;
    float d = uv.y - c;
    float body = exp(-d * d * 7.0) * mix(1.0, 0.35, smoothstep(-0.1, 0.2, d));
    // Vertical ray texture that makes it read as hanging cloth.
    float rays = 0.55 + 0.45 * n(vec2(x * 6.0 + fi * 11.0, t * 4.0 + uv.y * 1.5));
    float fold = 0.5 + 0.5 * n(vec2(x * 1.6 - t * 2.0, fi + uv.y * 0.8));
    col += mix(blue, violet, fold * (0.4 + fi * 0.3)) * body * rays * fold * 0.34 * sweep;
  }
  col += (h(gl_FragCoord.xy) - 0.5) / 255.0;
  o = vec4(col, 1.0);
}`;

function draw2d(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, i: number): void {
  ctx.fillStyle = "#07080c";
  ctx.fillRect(0, 0, w, h);
  for (let k = 0; k < 3; k++) {
    const x = w * (0.25 + k * 0.25) + Math.sin(t * 0.15 + k * 2) * w * 0.08;
    const g = ctx.createRadialGradient(x, h * 0.55, 0, x, h * 0.55, w * 0.4);
    g.addColorStop(0, `rgba(${k === 1 ? "118,77,242" : "41,92,242"},${0.35 * i})`);
    g.addColorStop(1, "rgba(7,8,12,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
}

export const aurora: Variant = { frag, draw2d };
