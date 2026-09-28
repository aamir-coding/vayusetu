/**
 * Hero background: air currents streaming around a hex-grid globe whose
 * hotspots cool from red to green as you scroll ("the air clears").
 *
 * Built to be cheap on phones:
 *   - particle motion is computed in the vertex shader (no per-particle CPU
 *     work, one draw call); ~900 particles on phones, ~2400 on desktop
 *   - renders only while the hero is on screen and the tab is visible,
 *     capped at 30 fps on phones; pixel ratio capped
 *   - prefers-reduced-motion: one still frame, redrawn on theme/resize
 * The page loads this lazily, after first paint, and skips it entirely with
 * Save-Data or on very low-memory devices (see index.html).
 *
 * Bundled into public/assets/scene.js by `pnpm --filter @vayusetu/portal build`.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  EdgesGeometry,
  Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  LineSegments,
  NormalBlending,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from 'three';

const THEMES = {
  dark: { dirty: '#f2a33a', clean: '#34d3a0', grid: '#6fd6c4', gridOpacity: 0.2, hot: '#ff5a4e', cool: '#34d3a0', blending: AdditiveBlending, alpha: 1 },
  light: { dirty: '#c2620c', clean: '#0f8a78', grid: '#0f6b61', gridOpacity: 0.16, hot: '#dc2626', cool: '#059669', blending: NormalBlending, alpha: 0.75 },
};

const WIND_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uClear;
  uniform float uSpan;
  uniform float uHeight;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform vec3 uGlobe;
  uniform vec3 uDirty;
  uniform vec3 uClean;
  attribute vec3 aSeed; // x: lane (-1..1), y: phase (0..1), z: speed
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    float t = fract(aSeed.y + uTime * (0.02 + aSeed.z * 0.035));
    float x = mix(-0.62, 0.62, t) * uSpan;
    float y = aSeed.x * uHeight;
    // Wind: layered, slowly drifting waves.
    y += 0.30 * sin(x * 0.8 + uTime * 0.22 + aSeed.x * 3.1) + 0.12 * sin(x * 2.3 - uTime * 0.31 + aSeed.x * 7.7);
    // Flow around the globe instead of through it.
    vec2 d = vec2(x, y) - uGlobe.xy;
    float r = max(length(d), 0.001);
    y += (d.y / r) * exp(-pow(max(r - uGlobe.z * 0.9, 0.0), 2.0) * 1.4) * 0.55;
    float z = -0.8 + aSeed.x * 0.9;

    vec4 mv = modelViewMatrix * vec4(x, y, z, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * uPixelRatio * (0.7 + 0.8 * fract(aSeed.z * 13.37)) * (6.0 / -mv.z);
    vAlpha = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.88, 1.0, t));
    float mixv = clamp(uClear * 1.15 + 0.12 * sin(aSeed.x * 11.0) - 0.05, 0.0, 1.0);
    vColor = mix(uDirty, uClean, mixv);
  }
`;

const DOT_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    gl_FragColor = vec4(vColor, smoothstep(0.5, 0.05, d) * vAlpha * uOpacity);
  }
`;

const HOT_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uClear;
  uniform float uPixelRatio;
  uniform vec3 uHot;
  uniform vec3 uCool;
  attribute float aPhase;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float pulse = 0.55 + 0.45 * sin(uTime * 1.6 + aPhase * 6.2831);
    // Hotspots cool one by one as the page scrolls.
    float cooled = smoothstep(aPhase * 0.8, aPhase * 0.8 + 0.2, uClear);
    gl_PointSize = (5.0 + 7.0 * pulse * (1.0 - cooled * 0.5)) * uPixelRatio * (6.0 / -mv.z);
    // Only the front hemisphere glows.
    vAlpha = smoothstep(-0.2, 0.6, normalize(mv.xyz).z * -1.0);
    vColor = mix(uHot, uCool, cooled);
  }
`;

export function mountScene(canvas, { reduced = false, mobile = false, getTheme, getClear }) {
  const renderer = new WebGLRenderer({ canvas, antialias: !mobile, alpha: true, powerPreference: 'low-power' });
  const pixelRatio = Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.75);
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.1, 50);
  camera.position.set(0, 0, 6);

  // ---- globe: an H3-like hex shell + hotspot dots
  const globe = new Group();
  const shell = new IcosahedronGeometry(1.55, 3);
  const gridMat = new LineBasicMaterial({ transparent: true, depthWrite: false });
  globe.add(new LineSegments(new EdgesGeometry(shell), gridMat));

  const verts = shell.getAttribute('position');
  const picked = [];
  const phases = [];
  for (let i = 0; i < verts.count && picked.length < 3 * 46; i += 7) {
    picked.push(verts.getX(i) * 1.01, verts.getY(i) * 1.01, verts.getZ(i) * 1.01);
    phases.push(((i * 0.6180339) % 1));
  }
  const hotGeo = new BufferGeometry();
  hotGeo.setAttribute('position', new BufferAttribute(new Float32Array(picked), 3));
  hotGeo.setAttribute('aPhase', new BufferAttribute(new Float32Array(phases), 1));
  const hotMat = new ShaderMaterial({
    vertexShader: HOT_VERT,
    fragmentShader: DOT_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uClear: { value: 0 }, uPixelRatio: { value: pixelRatio }, uHot: { value: new Color() }, uCool: { value: new Color() }, uOpacity: { value: 1 } },
  });
  globe.add(new Points(hotGeo, hotMat));
  globe.rotation.set(0.35, 0, 0.12);
  scene.add(globe);

  // ---- wind particles
  const count = mobile ? 900 : 2400;
  const seeds = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    seeds[i * 3] = Math.random() * 2 - 1;
    seeds[i * 3 + 1] = Math.random();
    seeds[i * 3 + 2] = Math.random();
  }
  const windGeo = new BufferGeometry();
  windGeo.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3)); // positions come from the shader
  windGeo.setAttribute('aSeed', new BufferAttribute(seeds, 3));
  const windMat = new ShaderMaterial({
    vertexShader: WIND_VERT,
    fragmentShader: DOT_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uClear: { value: 0 },
      uSpan: { value: 10 },
      uHeight: { value: 3 },
      uSize: { value: mobile ? 3.4 : 4.2 },
      uPixelRatio: { value: pixelRatio },
      uGlobe: { value: [0, 0, 1.55] },
      uDirty: { value: new Color() },
      uClean: { value: new Color() },
      uOpacity: { value: 0.85 },
    },
  });
  const wind = new Points(windGeo, windMat);
  wind.frustumCulled = false; // bounds come from the shader
  scene.add(wind);

  // ---- theme
  let themeName = '';
  function applyTheme() {
    const name = getTheme() === 'light' ? 'light' : 'dark';
    if (name === themeName) return;
    themeName = name;
    const t = THEMES[name];
    gridMat.color.set(t.grid);
    gridMat.opacity = t.gridOpacity;
    windMat.uniforms.uDirty.value.set(t.dirty);
    windMat.uniforms.uClean.value.set(t.clean);
    windMat.uniforms.uOpacity.value = t.alpha;
    hotMat.uniforms.uHot.value.set(t.hot);
    hotMat.uniforms.uCool.value.set(t.cool);
    windMat.blending = hotMat.blending = t.blending;
    windMat.needsUpdate = hotMat.needsUpdate = true;
  }

  // ---- layout: globe to the right on wide screens, behind the headline on phones
  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const visH = 2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.z;
    const visW = visH * camera.aspect;
    const wide = camera.aspect > 1.1;
    globe.position.set(wide ? visW * 0.24 : 0, wide ? 0 : visH * 0.2, 0);
    globe.scale.setScalar(wide ? 1 : Math.min(0.78, visW / 4.6));
    windMat.uniforms.uSpan.value = visW * 1.25;
    windMat.uniforms.uHeight.value = visH * 0.48;
    windMat.uniforms.uGlobe.value = [globe.position.x, globe.position.y, 1.55 * globe.scale.x];
  }

  // ---- pointer parallax (desktop only)
  const target = { x: 0, y: 0 };
  const onPointer = (e) => {
    target.x = (e.clientX / window.innerWidth - 0.5) * 0.35;
    target.y = (e.clientY / window.innerHeight - 0.5) * 0.25;
  };
  if (!mobile && !reduced) window.addEventListener('pointermove', onPointer, { passive: true });

  // ---- loop
  let visible = true;
  let raf = 0;
  let last = 0;
  let time = 0;
  const frameMs = mobile ? 1000 / 30 : 0;

  function draw(dt) {
    applyTheme();
    const clear = getClear();
    time += dt;
    windMat.uniforms.uTime.value = time;
    windMat.uniforms.uClear.value = clear;
    hotMat.uniforms.uTime.value = time;
    hotMat.uniforms.uClear.value = clear;
    globe.rotation.y += dt * 0.06;
    scene.rotation.y += (target.x - scene.rotation.y) * 0.04;
    scene.rotation.x += (target.y - scene.rotation.x) * 0.04;
    renderer.render(scene, camera);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    if (frameMs && now - last < frameMs) return;
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0.016;
    last = now;
    draw(dt);
  }

  const still = () => {
    time = 8; // a pleasing frame, not t=0 where every particle starts at the edge
    draw(0);
  };

  const ro = new ResizeObserver(() => {
    resize();
    if (reduced) still();
  });
  ro.observe(canvas);
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible) last = 0;
  });
  io.observe(canvas);

  resize();
  if (reduced) still();
  else raf = requestAnimationFrame(frame);

  return {
    /** Redraw now (theme change / scroll while reduced motion is on). */
    refresh() {
      if (reduced) still();
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener('pointermove', onPointer);
      renderer.dispose();
    },
  };
}
