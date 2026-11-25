import type { Variant } from "./runtime";

const frag = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform float uTime, uIntro;
out vec4 o;

float h(float p) { return fract(sin(p * 127.1) * 43758.5453); }

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float ar = uRes.x / uRes.y;
  float horizon = 0.6;
  vec3 col = vec3(0.027, 0.030, 0.045);

  // Perspective flattens in at first, then settles.
  float d = abs(uv.y - horizon) * mix(2.6, 1.0, uIntro) + 0.002;
  float side = uv.y < horizon ? 1.0 : 0.35;
  float z = 0.3 / d;
  float xw = (uv.x - 0.5) * ar / d * 0.55;

  float lx = abs(fract(xw + 0.5) - 0.5);
  float zz = z - uTime * 0.35;
  float lz = abs(fract(zz) - 0.5);
  float wx = fwidth(xw) * 1.1, wz = fwidth(zz) * 1.1;
  float vline = 1.0 - smoothstep(0.0, wx, lx);
  float hline = 1.0 - smoothstep(0.0, wz, lz);

  // Lines draw outward from the vanishing point during the opening.
  float r = length(vec2((uv.x - 0.5) * ar, (uv.y - horizon) * 1.6));
  float reveal = 1.0 - smoothstep(uIntro * 2.2 - 0.5, uIntro * 2.2, r);
  float fade = smoothstep(0.0, 0.25, d) * 0.9 + 0.1;
  float lines = max(vline, hline * 0.7) * reveal * fade;
  col += vec3(0.20, 0.30, 0.62) * lines * 0.55 * side;

  // Pulses travel from the horizon toward the viewer along each radial line.
  float id = floor(xw + 0.5);
  float rnd = h(id);
  if (rnd > 0.55) {
    float ph = fract(uTime * (0.08 + 0.1 * h(id + 3.0)) + rnd * 7.0);
    float pd = ph * 0.6;
    float w = 0.01 + 0.08 * pd;
    float g = exp(-pow((d - pd) / w, 2.0));
    col += vec3(0.55, 0.65, 1.0) * g * vline * reveal * smoothstep(0.7, 0.0, ph) * smoothstep(0.0, 0.05, ph) * 1.3 * side * step(0.6, uIntro);
  }
  col += vec3(0.10, 0.14, 0.32) * exp(-abs(uv.y - horizon) * 12.0) * 0.5 * uIntro;
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9, 78.2))) * 43758.5) - 0.5) / 255.0;
  o = vec4(col, 1.0);
}`;

function draw2d(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, i: number): void {
  ctx.fillStyle = "#07080c";
  ctx.fillRect(0, 0, w, h);
  const hy = h * 0.6;
  ctx.strokeStyle = `rgba(80,110,230,${0.4 * i})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = -12; k <= 12; k++) {
    ctx.moveTo(w / 2, hy);
    ctx.lineTo(w / 2 + k * w * 0.12, h);
  }
  for (let k = 0; k < 10; k++) {
    const y = hy + (h - hy) * Math.pow(((k + t * 0.3) % 10) / 10, 2);
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
}

export const grid: Variant = { frag, draw2d };
