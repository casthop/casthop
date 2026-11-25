import type { Variant } from "./runtime";

const frag = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform float uTime, uIntro;
out vec4 o;

float h(float p) { return fract(sin(p * 127.1) * 43758.5453); }
float ease(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }

// Brightness of one light streak: thin core, soft halo, a travelling head.
float streak(vec2 uv, float y, float ar, float seed, float speed, float dir) {
  float d = abs(uv.y - y);
  float core = exp(-d * d * 90000.0) * 0.5 + exp(-d * d * 2500.0) * 0.18;
  float ph = fract(uv.x * ar * 0.6 * dir - uTime * speed + seed);
  return core * (0.25 + 1.4 * pow(ph, 6.0) * smoothstep(1.0, 0.8, ph));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float ar = uRes.x / uRes.y;
  float xc = 0.4, y0 = 0.5;
  float conv = ease(uIntro / 0.6);
  float fan = ease((uIntro - 0.5) / 0.5);
  vec3 col = vec3(0.027, 0.030, 0.045);
  vec3 blue = vec3(0.36, 0.52, 1.0), violet = vec3(0.56, 0.46, 1.0);

  // Incoming lanes: parallel at first, then pulled into one stream.
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float yi = 0.08 + 0.84 * (fi + 0.5) / 9.0;
    float s = ease(uv.x / xc) * conv;
    float y = mix(yi, y0, s);
    float m = 1.0 - ease((uv.x - xc) / 0.04);
    col += blue * streak(uv, y, ar, h(fi) * 5.0, 0.22 + 0.1 * h(fi + 9.0), 1.0) * m * 0.8;
  }
  // The composite: one brighter stream where the lanes meet.
  float cd = abs(uv.y - y0);
  float core = exp(-cd * cd * 12000.0) * smoothstep(xc - 0.2, xc, uv.x) * conv;
  col += vec3(0.75, 0.82, 1.0) * core * (0.55 + 0.25 * sin(uTime * 1.3 - uv.x * 9.0));

  // Outgoing paths to five destinations.
  for (int j = 0; j < 5; j++) {
    float fj = float(j);
    float yj = 0.14 + 0.72 * fj / 4.0;
    float s = ease((uv.x - xc) / (1.0 - xc)) * fan;
    float y = mix(y0, yj, s);
    float m = ease((uv.x - xc) / 0.04) * fan;
    col += violet * streak(uv, y, ar, h(fj + 20.0) * 5.0, 0.2 + 0.08 * h(fj + 40.0), -1.0) * m;
    // Quiet endpoint marker at the right edge.
    vec2 e = (uv - vec2(0.97, yj)) * vec2(ar, 1.0);
    col += violet * exp(-dot(e, e) * 6000.0) * 0.5 * fan;
  }
  col += vec3(0.06, 0.09, 0.2) * exp(-pow((uv.x - xc) * 4.0, 2.0)) * 0.3 * uIntro;
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9, 78.2))) * 43758.5) - 0.5) / 255.0;
  o = vec4(col, 1.0);
}`;

function draw2d(ctx: CanvasRenderingContext2D, w: number, h: number, _t: number, i: number): void {
  ctx.fillStyle = "#07080c";
  ctx.fillRect(0, 0, w, h);
  ctx.lineWidth = 1.5;
  const x0 = w * 0.4;
  const curve = (y1: number, y2: number, left: boolean): void => {
    ctx.beginPath();
    ctx.moveTo(left ? 0 : x0, left ? y1 : h / 2);
    const xe = left ? x0 : w;
    ctx.bezierCurveTo(xe * 0.6, y1, xe * 0.6, y2, xe, y2);
    ctx.stroke();
  };
  ctx.strokeStyle = `rgba(92,133,255,${0.6 * i})`;
  for (let k = 0; k < 9; k++) curve(h * (0.08 + 0.84 * (k + 0.5) / 9), h / 2, true);
  ctx.strokeStyle = `rgba(143,117,255,${0.6 * i})`;
  for (let k = 0; k < 5; k++) curve(h / 2, h * (0.14 + 0.18 * k), false);
}

export const fanout: Variant = { frag, draw2d };
