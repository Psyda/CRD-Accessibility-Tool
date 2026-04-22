// filter.js. Shared WebGL filter stack. Used by both overlay and control panel preview.
// Imported via <script src="filter.js"> in renderer contexts.

const VS = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS_BLUR = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_radius;
uniform float u_sigma;
uniform bool u_enabled;
uniform vec2 u_axis; // (1,0) for horizontal pass, (0,1) for vertical pass

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec4 center = texture(u_tex, v_uv);
  if (!u_enabled || u_radius < 0.5) {
    outColor = center;
    return;
  }
  // Separable bilateral approximation. Run this shader twice:
  //  pass 1: u_axis = (1,0) horizontal
  //  pass 2: u_axis = (0,1) vertical, sampling from pass 1's output
  // Mathematically not equivalent to a 2D bilateral but visually indistinguishable
  // for our use case, and O(2r) instead of O(r^2). ~3.5x speedup at radius 3.
  float cl = luma(center.rgb);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  int R = int(u_radius);
  float sigmaSpace = u_radius * 0.6;
  float sigmaRange = max(u_sigma, 0.001);
  for (int i = -8; i <= 8; i++) {
    if (i < -R || i > R) continue;
    vec2 o = u_axis * float(i) * u_texel;
    vec4 s = texture(u_tex, v_uv + o);
    float sl = luma(s.rgb);
    float ws = exp(-float(i*i) / (2.0 * sigmaSpace * sigmaSpace));
    float wr = exp(-(sl - cl) * (sl - cl) / (2.0 * sigmaRange * sigmaRange));
    float w = ws * wr;
    sum += s.rgb * w;
    wsum += w;
  }
  outColor = vec4(sum / max(wsum, 0.0001), center.a);
}`;

const FS_COMPOSITE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_original;
uniform sampler2D u_blurred;
uniform vec2 u_texel;

uniform bool u_edgeOn;
uniform float u_edgeThreshold;
uniform float u_edgeThickness;
uniform float u_edgeStrength;
uniform vec3 u_edgeColor;
uniform int u_edgeSource;
uniform int u_edgeMode;

uniform bool u_rampOn;
uniform int u_rampDriver;
uniform float u_rampMix;
uniform float u_rampContrast;
uniform int u_rampCount;
uniform float u_rampPos[8];
uniform vec3 u_rampColor[8];

uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;

uniform bool u_previewOriginal;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

float sobel(sampler2D tex, vec2 uv, vec2 texel, float thickness, int srcMode) {
  float t = max(thickness, 1.0);
  vec2 o = texel * t;
  vec3 tl = texture(tex, uv + vec2(-o.x,  o.y)).rgb;
  vec3 tc = texture(tex, uv + vec2( 0.0,  o.y)).rgb;
  vec3 tr = texture(tex, uv + vec2( o.x,  o.y)).rgb;
  vec3 ml = texture(tex, uv + vec2(-o.x,  0.0)).rgb;
  vec3 mr = texture(tex, uv + vec2( o.x,  0.0)).rgb;
  vec3 bl = texture(tex, uv + vec2(-o.x, -o.y)).rgb;
  vec3 bc = texture(tex, uv + vec2( 0.0, -o.y)).rgb;
  vec3 br = texture(tex, uv + vec2( o.x, -o.y)).rgb;

  float lumEdge = 0.0;
  float chromaEdge = 0.0;

  if (srcMode == 0 || srcMode == 2) {
    float gx = luma(tr) + 2.0*luma(mr) + luma(br) - luma(tl) - 2.0*luma(ml) - luma(bl);
    float gy = luma(tl) + 2.0*luma(tc) + luma(tr) - luma(bl) - 2.0*luma(bc) - luma(br);
    lumEdge = sqrt(gx*gx + gy*gy);
  }
  if (srcMode == 1 || srcMode == 2) {
    vec3 opA = vec3(tl.r - tl.g, tc.r - tc.g, tr.r - tr.g);
    vec3 opB = vec3(ml.r - ml.g, 0.0, mr.r - mr.g);
    vec3 opC = vec3(bl.r - bl.g, bc.r - bc.g, br.r - br.g);
    vec3 opA2 = vec3(tl.b - (tl.r + tl.g)*0.5, tc.b - (tc.r + tc.g)*0.5, tr.b - (tr.r + tr.g)*0.5);
    vec3 opB2 = vec3(ml.b - (ml.r + ml.g)*0.5, 0.0, mr.b - (mr.r + mr.g)*0.5);
    vec3 opC2 = vec3(bl.b - (bl.r + bl.g)*0.5, bc.b - (bc.r + bc.g)*0.5, br.b - (br.r + br.g)*0.5);
    float ga1 = opA.z + 2.0*opB.z + opC.z - opA.x - 2.0*opB.x - opC.x;
    float gb1 = opA.x + 2.0*opA.y + opA.z - opC.x - 2.0*opC.y - opC.z;
    float ga2 = opA2.z + 2.0*opB2.z + opC2.z - opA2.x - 2.0*opB2.x - opC2.x;
    float gb2 = opA2.x + 2.0*opA2.y + opA2.z - opC2.x - 2.0*opC2.y - opC2.z;
    chromaEdge = sqrt(ga1*ga1 + gb1*gb1 + ga2*ga2 + gb2*gb2) * 0.7;
  }

  if (srcMode == 0) return lumEdge;
  if (srcMode == 1) return chromaEdge;
  return max(lumEdge, chromaEdge);
}

vec3 applyRamp(vec3 color) {
  float d;
  if (u_rampDriver == 0) d = luma(color);
  else if (u_rampDriver == 1) d = rgb2hsv(color).x;
  else if (u_rampDriver == 2) d = rgb2hsv(color).y;
  else if (u_rampDriver == 3) d = color.r;
  else if (u_rampDriver == 4) d = color.g;
  else d = color.b;

  d = clamp((d - 0.5) * u_rampContrast + 0.5, 0.0, 1.0);

  vec3 result = u_rampColor[0];
  for (int i = 0; i < 8; i++) {
    if (i >= u_rampCount - 1) break;
    float p0 = u_rampPos[i];
    float p1 = u_rampPos[i+1];
    if (d >= p0 && d <= p1) {
      float t = (d - p0) / max(p1 - p0, 0.0001);
      result = mix(u_rampColor[i], u_rampColor[i+1], t);
    }
  }
  if (d >= u_rampPos[u_rampCount-1]) result = u_rampColor[u_rampCount-1];
  return mix(color, result, u_rampMix);
}

void main() {
  vec3 original = texture(u_original, v_uv).rgb;

  if (u_previewOriginal) {
    outColor = vec4(original, 1.0);
    return;
  }

  vec3 base = texture(u_blurred, v_uv).rgb;

  if (u_rampOn) {
    base = applyRamp(base);
  }

  if (u_edgeOn) {
    float e = sobel(u_blurred, v_uv, u_texel, u_edgeThickness, u_edgeSource);
    float edgeMask = smoothstep(u_edgeThreshold, u_edgeThreshold + 0.05, e) * u_edgeStrength;
    if (u_edgeMode == 0) {
      base = base + u_edgeColor * edgeMask;
    } else if (u_edgeMode == 1) {
      base = mix(base, u_edgeColor, edgeMask);
    } else {
      base = mix(vec3(0.0), u_edgeColor, edgeMask);
    }
  }

  base = (base - 0.5) * u_contrast + 0.5 + u_brightness;
  float l = luma(base);
  base = mix(vec3(l), base, u_saturation);

  outColor = vec4(clamp(base, 0.0, 1.0), 1.0);
}`;

// ============================================================================
// Filter class. Wraps WebGL setup + render.
// ============================================================================
class VisionFilter {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      alpha: true,
    });
    if (!this.gl) throw new Error('WebGL2 required.');

    this.width = 0;
    this.height = 0;
    this.settings = this.defaultSettings();

    this._initPrograms();
    this._initBuffers();
    this._initTextures();
  }

  defaultSettings() {
    return {
      blurOn: true, blurRadius: 3, blurSigma: 0.12,
      edgeOn: true, edgeThreshold: 0.15, edgeThickness: 1, edgeStrength: 1.0,
      edgeColor: [1, 1, 0], edgeSource: 2, edgeMode: 1,
      rampOn: true, rampDriver: 0, rampMix: 1.0, rampContrast: 1.0,
      // Blue-to-yellow luminance ramp. Tritan-safe axis that CRD preserves longest.
      rampStops: [
        { pos: 0.0, color: [0.04, 0.06, 0.25] },  // deep blue (shadows)
        { pos: 0.35, color: [0.25, 0.35, 0.65] }, // mid blue
        { pos: 0.65, color: [0.75, 0.70, 0.35] }, // warm transition
        { pos: 1.0, color: [1.0, 0.95, 0.55] },   // warm yellow (highlights)
      ],
      brightness: 0, contrast: 1, saturation: 1,
      previewOriginal: false,
    };
  }

  _compile(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(s));
      throw new Error('shader compile failed');
    }
    return s;
  }

  _program(vsSrc, fsSrc) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this._compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, this._compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(p));
      throw new Error('link failed');
    }
    return p;
  }

  _initPrograms() {
    this.progBlur = this._program(VS, FS_BLUR);
    this.progComp = this._program(VS, FS_COMPOSITE);
  }

  _initBuffers() {
    const gl = this.gl;
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
      -1,  1, 0, 1,
       1, -1, 1, 0,
       1,  1, 1, 1,
    ]), gl.STATIC_DRAW);
  }

  _bindQuad(prog) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    const posLoc = gl.getAttribLocation(prog, 'a_pos');
    const uvLoc = gl.getAttribLocation(prog, 'a_uv');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
  }

  _initTextures() {
    const gl = this.gl;
    this.texOriginal = gl.createTexture();
    this.texBlurH = gl.createTexture();  // intermediate: horizontal blur result
    this.texBlurred = gl.createTexture(); // final blur result (after vertical pass)
    this.fboBlur = gl.createFramebuffer();
  }

  _setupTex(tex, w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  updateSettings(patch) {
    Object.assign(this.settings, patch);
  }

  // source can be HTMLImageElement, HTMLVideoElement, HTMLCanvasElement.
  uploadSource(source, flipY = true) {
    const gl = this.gl;
    const w = source.videoWidth || source.naturalWidth || source.width;
    const h = source.videoHeight || source.naturalHeight || source.height;
    if (!w || !h) return false;

    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.canvas.width = w;
      this.canvas.height = h;
      this._setupTex(this.texBlurH, w, h);
      this._setupTex(this.texBlurred, w, h);
    }

    gl.bindTexture(gl.TEXTURE_2D, this.texOriginal);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return true;
  }

  render() {
    if (!this.width || !this.height) return;
    const gl = this.gl;
    const s = this.settings;

    // BLUR: two separable passes (horizontal, then vertical).
    // Pass 1a: original -> texBlurH (horizontal)
    gl.useProgram(this.progBlur);
    this._bindQuad(this.progBlur);
    gl.uniform2f(gl.getUniformLocation(this.progBlur, 'u_texel'), 1 / this.width, 1 / this.height);
    gl.uniform1f(gl.getUniformLocation(this.progBlur, 'u_radius'), s.blurRadius);
    gl.uniform1f(gl.getUniformLocation(this.progBlur, 'u_sigma'), s.blurSigma);
    gl.uniform1i(gl.getUniformLocation(this.progBlur, 'u_enabled'), s.blurOn ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(this.progBlur, 'u_tex'), 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboBlur);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texBlurH, 0);
    gl.viewport(0, 0, this.width, this.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texOriginal);
    gl.uniform2f(gl.getUniformLocation(this.progBlur, 'u_axis'), 1, 0); // horizontal
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Pass 1b: texBlurH -> texBlurred (vertical)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texBlurred, 0);
    gl.bindTexture(gl.TEXTURE_2D, this.texBlurH);
    gl.uniform2f(gl.getUniformLocation(this.progBlur, 'u_axis'), 0, 1); // vertical
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Pass 2: composite to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.progComp);
    this._bindQuad(this.progComp);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texOriginal);
    gl.uniform1i(gl.getUniformLocation(this.progComp, 'u_original'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texBlurred);
    gl.uniform1i(gl.getUniformLocation(this.progComp, 'u_blurred'), 1);
    gl.uniform2f(gl.getUniformLocation(this.progComp, 'u_texel'), 1 / this.width, 1 / this.height);

    gl.uniform1i(gl.getUniformLocation(this.progComp, 'u_edgeOn'), s.edgeOn ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.progComp, 'u_edgeThreshold'), s.edgeThreshold);
    gl.uniform1f(gl.getUniformLocation(this.progComp, 'u_edgeThickness'), s.edgeThickness);
    gl.uniform1f(gl.getUniformLocation(this.progComp, 'u_edgeStrength'), s.edgeStrength);
    gl.uniform3fv(gl.getUniformLocation(this.progComp, 'u_edgeColor'), s.edgeColor);
    gl.uniform1i(gl.getUniformLocation(this.progComp, 'u_edgeSource'), s.edgeSource);
    gl.uniform1i(gl.getUniformLocation(this.progComp, 'u_edgeMode'), s.edgeMode);

    gl.uniform1i(gl.getUniformLocation(this.progComp, 'u_rampOn'), s.rampOn ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(this.progComp, 'u_rampDriver'), s.rampDriver);
    gl.uniform1f(gl.getUniformLocation(this.progComp, 'u_rampMix'), s.rampMix);
    gl.uniform1f(gl.getUniformLocation(this.progComp, 'u_rampContrast'), s.rampContrast);

    const sorted = [...s.rampStops].sort((a, b) => a.pos - b.pos).slice(0, 8);
    const positions = new Float32Array(8);
    const colors = new Float32Array(24);
    for (let i = 0; i < sorted.length; i++) {
      positions[i] = sorted[i].pos;
      colors[i * 3] = sorted[i].color[0];
      colors[i * 3 + 1] = sorted[i].color[1];
      colors[i * 3 + 2] = sorted[i].color[2];
    }
    gl.uniform1i(gl.getUniformLocation(this.progComp, 'u_rampCount'), sorted.length);
    gl.uniform1fv(gl.getUniformLocation(this.progComp, 'u_rampPos'), positions);
    gl.uniform3fv(gl.getUniformLocation(this.progComp, 'u_rampColor'), colors);

    gl.uniform1f(gl.getUniformLocation(this.progComp, 'u_brightness'), s.brightness);
    gl.uniform1f(gl.getUniformLocation(this.progComp, 'u_contrast'), s.contrast);
    gl.uniform1f(gl.getUniformLocation(this.progComp, 'u_saturation'), s.saturation);
    gl.uniform1i(gl.getUniformLocation(this.progComp, 'u_previewOriginal'), s.previewOriginal ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

// Expose globally (no module system in plain <script> render contexts)
if (typeof window !== 'undefined') {
  window.VisionFilter = VisionFilter;
}
if (typeof module !== 'undefined') {
  module.exports = { VisionFilter };
}
