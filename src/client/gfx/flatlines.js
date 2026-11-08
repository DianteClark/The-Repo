// Ground-hugging ribbon segments in one instanced draw: engagement brackets
// and links, airstrike telegraph lines, claymore trip lines. Each segment
// can be solid or flowing-dashed, with its own colour and alpha. Rebuilt per
// frame from a plain list (cheap: tens of segments).

import * as THREE from 'three';

const VERT = /* glsl */`
attribute vec4 aCol;
attribute vec2 aDash; // x: dashed?, y: segment length (world)
varying vec2 vUv;
varying vec4 vCol;
varying vec2 vDash;
void main() {
  vUv = uv; vCol = aCol; vDash = aDash;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const FRAG = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying vec4 vCol;
varying vec2 vDash;
void main() {
  float across = 1.0 - smoothstep(0.6, 1.0, abs(vUv.x - 0.5) * 2.0);
  float d = 1.0;
  if (vDash.x > 0.5) d = smoothstep(0.35, 0.5, fract(vUv.y * vDash.y * 1.6 - uTime * 1.8)) * (1.0 - smoothstep(0.85, 1.0, fract(vUv.y * vDash.y * 1.6 - uTime * 1.8)));
  float a = vCol.a * across * mix(1.0, d, vDash.x);
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol.rgb, a);
}`;

const _m = new THREE.Matrix4(), _c = new THREE.Color();

export class FlatLines {
  constructor(parent, cap = 96, y = 0.14) {
    this.cap = cap; this.y = y;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    geo.rotateX(Math.PI / 2); // lies flat, length along +z
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aDash = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aCol', this.aCol);
    geo.setAttribute('aDash', this.aDash);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } }, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: false, toneMapped: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, cap);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.renderOrder = 8;
    parent.add(this.mesh);
    this.n = 0;
  }
  begin() { this.n = 0; }
  /** Segment (ax,az)→(bx,bz) of width w, colour (hex/Color), alpha a, dashed flag. */
  seg(ax, az, bx, bz, w, color, a = 1, dash = false, y = this.y) {
    if (this.n >= this.cap) return;
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    if (L < 1e-4) return;
    const i = this.n++;
    const ux = dx / L, uz = dz / L;
    // columns: x = across (w), y = up, z = along (L)
    _m.set(
      -uz * w, 0, ux * L, ax,
      0, 1, 0, y,
      ux * w, 0, uz * L, az,
      0, 0, 0, 1,
    );
    this.mesh.setMatrixAt(i, _m);
    _c.set(color);
    this.aCol.setXYZW(i, _c.r, _c.g, _c.b, a);
    this.aDash.setXY(i, dash ? 1 : 0, L);
  }
  /** Four L-shaped corners around a world-space box. */
  bracket(x0, z0, x1, z1, w, color, a = 1, arm = 0.45) {
    const ax = Math.min(arm, (x1 - x0) / 2), az = Math.min(arm, (z1 - z0) / 2);
    for (const [cx, cz, sx, sz] of [[x0, z0, 1, 1], [x1, z0, -1, 1], [x0, z1, 1, -1], [x1, z1, -1, -1]]) {
      this.seg(cx - sx * w / 2, cz, cx + sx * ax, cz, w, color, a);
      this.seg(cx, cz, cx, cz + sz * az, w, color, a);
    }
  }
  end(time) {
    this.mesh.count = this.n;
    this.mat.uniforms.uTime.value = time;
    if (this.n) { this.mesh.instanceMatrix.needsUpdate = true; this.aCol.needsUpdate = true; this.aDash.needsUpdate = true; }
  }
  dispose() { this.mesh.parent?.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}
