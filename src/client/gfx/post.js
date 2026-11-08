// Post-processing chain (loaded lazily so the game still runs if the addons
// importmap entry is missing): Render (MSAA) → UnrealBloom → Grade/vignette → Output.

import * as THREE from 'three';

const BASES = ['three/addons/', 'https://unpkg.com/three@0.170.0/examples/jsm/'];

let modsP = null;
export function loadPostModules() {
  if (modsP) return modsP;
  modsP = (async () => {
    for (const b of BASES) {
      try {
        const [ec, rp, ub, op, sp] = await Promise.all([
          import(b + 'postprocessing/EffectComposer.js'),
          import(b + 'postprocessing/RenderPass.js'),
          import(b + 'postprocessing/UnrealBloomPass.js'),
          import(b + 'postprocessing/OutputPass.js'),
          import(b + 'postprocessing/ShaderPass.js'),
        ]);
        // SSAO (high quality, desktop only) is optional: a missing addon never blocks post
        let GTAOPass = null;
        try { GTAOPass = (await import(b + 'postprocessing/GTAOPass.js')).GTAOPass; } catch { /* no AO */ }
        return { EffectComposer: ec.EffectComposer, RenderPass: rp.RenderPass, UnrealBloomPass: ub.UnrealBloomPass, OutputPass: op.OutputPass, ShaderPass: sp.ShaderPass, GTAOPass };
      } catch (e) { /* try next base */ }
    }
    return null;
  })();
  return modsP;
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uStorm: { value: 0 },
    uVignette: { value: 0.2 },
    uAspect: { value: 1 },
    uFlash: { value: 0 },
    uTime: { value: 0 },
    uDesat: { value: 0 },
    uTilt: { value: 0 }, // tilt-shift depth of field (title-screen showcase)
    uRes: { value: new THREE.Vector2(1, 1) },
    // 5.0 per-stage grade: lift (shadow tint), gain (highlight tint), saturation, contrast
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uSat: { value: 1 },
    uContrast: { value: 1 },
    uCA: { value: 0 }, // chromatic aberration (flashbang / big blasts)
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uStorm, uVignette, uAspect, uFlash, uTime, uDesat, uTilt, uSat, uContrast, uCA;
    uniform vec2 uRes;
    uniform vec3 uLift, uGain;
    varying vec2 vUv;
    float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      if (uCA > 0.001) {
        vec2 dir = (vUv - 0.5) * uCA * 0.012;
        col.r = texture2D(tDiffuse, vUv + dir).r;
        col.b = texture2D(tDiffuse, vUv - dir).b;
      }
      if (uTilt > 0.01) {
        // miniature-diorama tilt shift: sharp band across the middle, blur grows above/below
        float d = abs(vUv.y - 0.5);
        float r = smoothstep(0.1, 0.48, d) * 9.0 * uTilt;
        if (r > 0.3) {
          vec3 acc = col; float wsum = 1.0;
          float a0 = h(vUv * 517.0) * 6.2831;
          for (int i = 0; i < 12; i++) {
            float fi = float(i);
            float a = a0 + fi * 2.39996;
            float rr = r * sqrt((fi + 0.5) / 12.0);
            vec2 o = vec2(cos(a), sin(a)) * rr / uRes;
            acc += texture2D(tDiffuse, vUv + o).rgb; wsum += 1.0;
          }
          col = acc / wsum;
        }
      }
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      // golden hour: teal shadows, warm highlights
      vec3 golden = col * mix(vec3(0.9, 1.0, 1.07), vec3(1.07, 1.0, 0.9), smoothstep(0.02, 0.7, l));
      // storm: cooler, flatter, a touch desaturated
      vec3 storm = mix(vec3(l), col, 0.72) * vec3(0.9, 1.0, 1.1);
      col = mix(golden, storm, uStorm);
      float l2 = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l2), col, (1.12 - 0.12 * uStorm - uDesat * 0.8) * uSat);
      // filmic S-curve around mid grey + lift / gain colour balance
      // (linear HDR here: contrast pivots on mid grey 0.18, not 0.5)
      col = 0.18 * pow(max(col, vec3(1e-4)) / 0.18, vec3(uContrast));
      col = col * uGain + uLift * (1.0 - clamp(col, 0.0, 1.0));
      col += uFlash * vec3(0.9, 0.95, 1.0);
      vec2 q = vUv - 0.5; q.x *= uAspect;
      float v = smoothstep(0.92, 0.28, length(q));
      v = mix(v, v * smoothstep(1.0, 0.35, length(q)), uTilt * 0.6);
      col *= mix(1.0 - uVignette - uStorm * 0.12, 1.0, v);
      col += (h(vUv * 913.0 + uTime) - 0.5) * 0.018 * (0.4 + uStorm);
      gl_FragColor = vec4(col, c.a);
    }`,
};

/**
 * Screen-space AO for the diorama: GTAO over the opaque world only (particles,
 * water, glows, overlays and anything transparent are hidden from its normal
 * pass, so they neither receive nor cast AO).
 */
function makeAO(M, scene, camera, w, h) {
  class DioramaAO extends M.GTAOPass {
    overrideVisibility() {
      const cache = this._visibilityCache;
      this.scene.traverse((o) => {
        cache.set(o, o.visible);
        const m = o.material;
        if (o.isPoints || o.isLine || o.isSprite || (m && (Array.isArray(m) ? m.some((q) => q.transparent) : m.transparent || m.isShaderMaterial || m.isMeshBasicMaterial))) o.visible = false;
      });
    }
  }
  const ao = new DioramaAO(scene, camera, w, h);
  ao.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.6, thickness: 1.2, scale: 1.0, samples: 12 });
  ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
  ao.blendIntensity = 0.75;
  return ao;
}

export function createComposer(M, gl, scene, camera, { samples = 4, ao = false } = {}) {
  const size = gl.getDrawingBufferSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples });
  const composer = new M.EffectComposer(gl, rt);
  const render = new M.RenderPass(scene, camera);
  let aoPass = null;
  const bloom = new M.UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.55, 0.45, 0.92);
  const grade = new M.ShaderPass(GradeShader);
  const out = new M.OutputPass();
  composer.addPass(render);
  if (ao && M.GTAOPass) {
    try { aoPass = makeAO(M, scene, camera, size.x, size.y); composer.addPass(aoPass); } catch (e) { console.warn('AO unavailable', e); aoPass = null; }
  }
  composer.addPass(bloom);
  composer.addPass(grade);
  composer.addPass(out);
  return { composer, bloom, grade, out, rt, ao: aoPass };
}
