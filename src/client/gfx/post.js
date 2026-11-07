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
        return { EffectComposer: ec.EffectComposer, RenderPass: rp.RenderPass, UnrealBloomPass: ub.UnrealBloomPass, OutputPass: op.OutputPass, ShaderPass: sp.ShaderPass };
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
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uStorm, uVignette, uAspect, uFlash, uTime, uDesat;
    varying vec2 vUv;
    float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      // golden hour: teal shadows, warm highlights
      vec3 golden = col * mix(vec3(0.9, 1.0, 1.07), vec3(1.07, 1.0, 0.9), smoothstep(0.02, 0.7, l));
      // storm: cooler, flatter, a touch desaturated
      vec3 storm = mix(vec3(l), col, 0.72) * vec3(0.9, 1.0, 1.1);
      col = mix(golden, storm, uStorm);
      float l2 = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l2), col, 1.12 - 0.12 * uStorm - uDesat * 0.8);
      col += uFlash * vec3(0.9, 0.95, 1.0);
      vec2 q = vUv - 0.5; q.x *= uAspect;
      float v = smoothstep(0.92, 0.28, length(q));
      col *= mix(1.0 - uVignette - uStorm * 0.12, 1.0, v);
      col += (h(vUv * 913.0 + uTime) - 0.5) * 0.018 * (0.4 + uStorm);
      gl_FragColor = vec4(col, c.a);
    }`,
};

export function createComposer(M, gl, scene, camera, { samples = 4 } = {}) {
  const size = gl.getDrawingBufferSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples });
  const composer = new M.EffectComposer(gl, rt);
  const render = new M.RenderPass(scene, camera);
  const bloom = new M.UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.55, 0.45, 0.92);
  const grade = new M.ShaderPass(GradeShader);
  const out = new M.OutputPass();
  composer.addPass(render);
  composer.addPass(bloom);
  composer.addPass(grade);
  composer.addPass(out);
  return { composer, bloom, grade, out, rt };
}
