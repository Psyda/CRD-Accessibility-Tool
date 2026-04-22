// filter.js. Shared WebGL filter stack. Used by both overlay and control panel preview.
// Refactored to data-driven modifier stack architecture.

const VS = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// ============================================================================
// SHADER FRAGMENTS
// ============================================================================

const FS_BLUR = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_radius;
uniform float u_sigma;
uniform vec2 u_axis; // (1,0) for horizontal pass, (0,1) for vertical pass

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec4 center = texture(u_tex, v_uv);
  if (u_radius < 0.5) {
    outColor = center;
    return;
  }
  // Separable bilateral approximation
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

const FS_SOBEL = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_threshold;
uniform float u_thickness;
uniform float u_strength;
uniform vec3 u_color;
uniform int u_source; // 0=luminance, 1=chrominance, 2=both
uniform int u_mode; // 0=overlay(add), 1=replace, 2=outline-only

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

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

void main() {
  vec3 base = texture(u_tex, v_uv).rgb;
  float e = sobel(u_tex, v_uv, u_texel, u_thickness, u_source);
  float edgeMask = smoothstep(u_threshold, u_threshold + 0.05, e) * u_strength;

  if (u_mode == 0) {
    outColor = vec4(base + u_color * edgeMask, 1.0);
  } else if (u_mode == 1) {
    outColor = vec4(mix(base, u_color, edgeMask), 1.0);
  } else {
    outColor = vec4(mix(vec3(0.0), u_color, edgeMask), 1.0);
  }
}`;

const FS_COLORRAMP = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform int u_driver; // 0=luma, 1=hue, 2=sat, 3=r, 4=g, 5=b
uniform float u_mix;
uniform float u_contrast;
uniform int u_stopCount;
uniform float u_stopPos[8];
uniform vec3 u_stopColor[8];

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

void main() {
  vec3 color = texture(u_tex, v_uv).rgb;

  float d;
  if (u_driver == 0) d = luma(color);
  else if (u_driver == 1) d = rgb2hsv(color).x;
  else if (u_driver == 2) d = rgb2hsv(color).y;
  else if (u_driver == 3) d = color.r;
  else if (u_driver == 4) d = color.g;
  else d = color.b;

  d = clamp((d - 0.5) * u_contrast + 0.5, 0.0, 1.0);

  vec3 result = u_stopColor[0];
  for (int i = 0; i < 8; i++) {
    if (i >= u_stopCount - 1) break;
    float p0 = u_stopPos[i];
    float p1 = u_stopPos[i+1];
    if (d >= p0 && d <= p1) {
      float t = (d - p0) / max(p1 - p0, 0.0001);
      result = mix(u_stopColor[i], u_stopColor[i+1], t);
    }
  }
  if (d >= u_stopPos[u_stopCount-1]) result = u_stopColor[u_stopCount-1];

  outColor = vec4(mix(color, result, u_mix), 1.0);
}`;

const FS_COLORADJUST = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec3 color = texture(u_tex, v_uv).rgb;
  color = (color - 0.5) * u_contrast + 0.5 + u_brightness;
  float l = luma(color);
  color = mix(vec3(l), color, u_saturation);
  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

const FS_HUESHIFT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform float u_shift; // hue shift in radians

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec3 color = texture(u_tex, v_uv).rgb;
  vec3 hsv = rgb2hsv(color);
  hsv.x = fract(hsv.x + u_shift / 6.2831853);
  outColor = vec4(hsv2rgb(hsv), 1.0);
}`;

const FS_LUMTHRESHOLD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform float u_threshold;
uniform float u_range;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec3 color = texture(u_tex, v_uv).rgb;
  float l = luma(color);
  float alpha = smoothstep(u_threshold - u_range * 0.5, u_threshold + u_range * 0.5, l);
  outColor = vec4(color * alpha, 1.0);
}`;

const FS_CHANNELMIXER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec3 u_redMix;   // RGB multipliers for output red
uniform vec3 u_greenMix; // RGB multipliers for output green
uniform vec3 u_blueMix;  // RGB multipliers for output blue

void main() {
  vec3 color = texture(u_tex, v_uv).rgb;
  vec3 result;
  result.r = dot(color, u_redMix);
  result.g = dot(color, u_greenMix);
  result.b = dot(color, u_blueMix);
  outColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}`;

const FS_CHROMAKEY = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec3 u_keyColor;
uniform float u_threshold;
uniform float u_smoothness;

void main() {
  vec3 color = texture(u_tex, v_uv).rgb;
  float dist = distance(color, u_keyColor);
  float alpha = smoothstep(u_threshold, u_threshold + u_smoothness, dist);
  outColor = vec4(color, alpha);
}`;

const FS_BLEND = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_base;
uniform sampler2D u_blend;
uniform int u_mode; // 0=normal, 1=multiply, 2=screen, 3=overlay, 4=add, 5=subtract, 6=difference, 7=lighten, 8=darken
uniform float u_mix;

vec3 blendNormal(vec3 a, vec3 b) { return b; }
vec3 blendMultiply(vec3 a, vec3 b) { return a * b; }
vec3 blendScreen(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - b); }
vec3 blendOverlay(vec3 a, vec3 b) {
  return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a));
}
vec3 blendAdd(vec3 a, vec3 b) { return a + b; }
vec3 blendSubtract(vec3 a, vec3 b) { return a - b; }
vec3 blendDifference(vec3 a, vec3 b) { return abs(a - b); }
vec3 blendLighten(vec3 a, vec3 b) { return max(a, b); }
vec3 blendDarken(vec3 a, vec3 b) { return min(a, b); }

void main() {
  vec3 base = texture(u_base, v_uv).rgb;
  vec3 blend = texture(u_blend, v_uv).rgb;
  vec3 result;

  if (u_mode == 0) result = blendNormal(base, blend);
  else if (u_mode == 1) result = blendMultiply(base, blend);
  else if (u_mode == 2) result = blendScreen(base, blend);
  else if (u_mode == 3) result = blendOverlay(base, blend);
  else if (u_mode == 4) result = blendAdd(base, blend);
  else if (u_mode == 5) result = blendSubtract(base, blend);
  else if (u_mode == 6) result = blendDifference(base, blend);
  else if (u_mode == 7) result = blendLighten(base, blend);
  else result = blendDarken(base, blend);

  outColor = vec4(mix(base, result, u_mix), 1.0);
}`;

const FS_PASSTHROUGH = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
void main() {
  outColor = texture(u_tex, v_uv);
}`;

// ============================================================================
// STAGE DEFINITIONS
// ============================================================================

let nextStageId = 1;

function createStage(type, params = {}) {
  const id = `stage_${nextStageId++}`;
  const base = { id, type, enabled: true };

  switch (type) {
    case 'blur':
      return { ...base, params: { radius: 3, sigma: 0.12, ...params } };
    case 'sobel':
      return { ...base, params: {
        threshold: 0.15, thickness: 1, strength: 1.0,
        color: [1, 1, 0], source: 2, mode: 1, ...params
      }};
    case 'colorramp':
      return { ...base, params: {
        driver: 0, mix: 1.0, contrast: 1.0,
        stops: params.stops || [
          { pos: 0.0, color: [0.04, 0.06, 0.25] },
          { pos: 0.35, color: [0.25, 0.35, 0.65] },
          { pos: 0.65, color: [0.75, 0.70, 0.35] },
          { pos: 1.0, color: [1.0, 0.95, 0.55] },
        ],
        ...params
      }};
    case 'colorAdjust':
      return { ...base, params: { brightness: 0, contrast: 1, saturation: 1, ...params } };
    case 'hueShift':
      return { ...base, params: { shift: 0, ...params } };
    case 'lumThreshold':
      return { ...base, params: { threshold: 0.5, range: 0.1, ...params } };
    case 'channelMixer':
      return { ...base, params: {
        redMix: [1, 0, 0], greenMix: [0, 1, 0], blueMix: [0, 0, 1], ...params
      }};
    case 'chromaKey':
      return { ...base, params: { keyColor: [0, 1, 0], threshold: 0.4, smoothness: 0.1, ...params } };
    case 'group':
      return { ...base, params: { blendMode: 0, mix: 1.0, ...params }, children: [] };
    default:
      throw new Error(`Unknown stage type: ${type}`);
  }
}

// ============================================================================
// VISION FILTER CLASS
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
    this.stack = this.defaultStack();

    // Framebuffer pool for ping-pong rendering
    this.fbos = [];
    this.textures = [];
    this.texOriginal = null;

    this._initPrograms();
    this._initBuffers();
  }

  defaultStack() {
    return [
      createStage('blur', { radius: 3, sigma: 0.12 }),
      createStage('sobel', { threshold: 0.15, thickness: 1, strength: 1.0 }),
      createStage('colorramp', { driver: 0, mix: 1.0, contrast: 1.0 }),
    ];
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
    this.programs = {
      blur: this._program(VS, FS_BLUR),
      sobel: this._program(VS, FS_SOBEL),
      colorramp: this._program(VS, FS_COLORRAMP),
      colorAdjust: this._program(VS, FS_COLORADJUST),
      hueShift: this._program(VS, FS_HUESHIFT),
      lumThreshold: this._program(VS, FS_LUMTHRESHOLD),
      channelMixer: this._program(VS, FS_CHANNELMIXER),
      chromaKey: this._program(VS, FS_CHROMAKEY),
      blend: this._program(VS, FS_BLEND),
      passthrough: this._program(VS, FS_PASSTHROUGH),
    };
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

  _ensureFBOs(count) {
    const gl = this.gl;
    while (this.fbos.length < count) {
      this.fbos.push(gl.createFramebuffer());
      this.textures.push(gl.createTexture());
    }
  }

  _setupTexture(tex, w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

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

      // Recreate original texture
      if (!this.texOriginal) this.texOriginal = gl.createTexture();
      this._setupTexture(this.texOriginal, w, h);

      // Recreate FBO textures
      for (const tex of this.textures) {
        this._setupTexture(tex, w, h);
      }
    }

    gl.bindTexture(gl.TEXTURE_2D, this.texOriginal);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return true;
  }

  updateStack(stack) {
    this.stack = stack;
  }

  updateStage(stageId, updates) {
    const stage = this._findStageById(stageId);
    if (stage) {
      if ('enabled' in updates) stage.enabled = updates.enabled;
      if ('params' in updates) Object.assign(stage.params, updates.params);
    }
  }

  _findStageById(id, stages = this.stack) {
    for (const s of stages) {
      if (s.id === id) return s;
      if (s.type === 'group' && s.children) {
        const found = this._findStageById(id, s.children);
        if (found) return found;
      }
    }
    return null;
  }

  render() {
    if (!this.width || !this.height) return;
    const gl = this.gl;

    // Count total stages needed (including blur's two-pass expansion)
    const stageCount = this._countRenderPasses(this.stack);
    this._ensureFBOs(stageCount + 2);

    // Start with original texture
    let currentInput = this.texOriginal;
    let bufferIndex = 0;

    // Walk the stack
    currentInput = this._renderStack(this.stack, currentInput, bufferIndex);

    // Final blit to canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this._blitTexture(currentInput);
  }

  _countRenderPasses(stages) {
    let count = 0;
    for (const s of stages) {
      if (!s.enabled) continue;
      if (s.type === 'blur') count += 2; // separable passes
      else if (s.type === 'group') count += this._countRenderPasses(s.children) + 1; // children + blend
      else count += 1;
    }
    return count;
  }

  _renderStack(stages, inputTex, startBufferIndex) {
    const gl = this.gl;
    let currentInput = inputTex;
    let bufferIndex = startBufferIndex;

    for (const stage of stages) {
      if (!stage.enabled) continue;

      if (stage.type === 'blur') {
        // Separable bilateral: horizontal then vertical
        currentInput = this._renderBlurPass(currentInput, bufferIndex++, { ...stage.params, axis: [1, 0] });
        currentInput = this._renderBlurPass(currentInput, bufferIndex++, { ...stage.params, axis: [0, 1] });
      } else if (stage.type === 'group') {
        currentInput = this._renderGroup(stage, currentInput, bufferIndex);
        bufferIndex += this._countRenderPasses(stage.children) + 1;
      } else {
        currentInput = this._renderStage(stage, currentInput, bufferIndex++);
      }
    }

    return currentInput;
  }

  _renderStage(stage, inputTex, bufferIndex) {
    const gl = this.gl;
    const fbo = this.fbos[bufferIndex];
    const outputTex = this.textures[bufferIndex];

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTex, 0);
    gl.viewport(0, 0, this.width, this.height);

    const prog = this.programs[stage.type];
    if (!prog) {
      console.warn(`No program for stage type ${stage.type}, using passthrough`);
      this._blitTexture(inputTex);
      return outputTex;
    }

    gl.useProgram(prog);
    this._bindQuad(prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_texel'), 1 / this.width, 1 / this.height);

    this._setStageUniforms(prog, stage);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return outputTex;
  }

  _renderBlurPass(inputTex, bufferIndex, params) {
    const gl = this.gl;
    const fbo = this.fbos[bufferIndex];
    const outputTex = this.textures[bufferIndex];

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTex, 0);
    gl.viewport(0, 0, this.width, this.height);

    const prog = this.programs.blur;
    gl.useProgram(prog);
    this._bindQuad(prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_texel'), 1 / this.width, 1 / this.height);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_radius'), params.radius || 3);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_sigma'), params.sigma || 0.12);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_axis'), params.axis[0], params.axis[1]);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return outputTex;
  }

  _renderGroup(group, inputTex, startBufferIndex) {
    const gl = this.gl;

    // Render children to a sub-buffer
    const childOutput = this._renderStack(group.children, inputTex, startBufferIndex);
    const childPassCount = this._countRenderPasses(group.children);
    const blendBufferIndex = startBufferIndex + childPassCount;

    // Blend child output with input using group's blend mode
    const fbo = this.fbos[blendBufferIndex];
    const outputTex = this.textures[blendBufferIndex];

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTex, 0);
    gl.viewport(0, 0, this.width, this.height);

    const prog = this.programs.blend;
    gl.useProgram(prog);
    this._bindQuad(prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_base'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, childOutput);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_blend'), 1);

    gl.uniform1i(gl.getUniformLocation(prog, 'u_mode'), group.params.blendMode || 0);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_mix'), group.params.mix || 1.0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return outputTex;
  }

  _setStageUniforms(prog, stage) {
    const gl = this.gl;
    const p = stage.params;

    switch (stage.type) {
      case 'sobel':
        gl.uniform1f(gl.getUniformLocation(prog, 'u_threshold'), p.threshold);
        gl.uniform1f(gl.getUniformLocation(prog, 'u_thickness'), p.thickness);
        gl.uniform1f(gl.getUniformLocation(prog, 'u_strength'), p.strength);
        gl.uniform3fv(gl.getUniformLocation(prog, 'u_color'), p.color);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_source'), p.source);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_mode'), p.mode);
        break;

      case 'colorramp':
        gl.uniform1i(gl.getUniformLocation(prog, 'u_driver'), p.driver);
        gl.uniform1f(gl.getUniformLocation(prog, 'u_mix'), p.mix);
        gl.uniform1f(gl.getUniformLocation(prog, 'u_contrast'), p.contrast);
        const sorted = [...p.stops].sort((a, b) => a.pos - b.pos).slice(0, 8);
        const positions = new Float32Array(8);
        const colors = new Float32Array(24);
        for (let i = 0; i < sorted.length; i++) {
          positions[i] = sorted[i].pos;
          colors[i * 3] = sorted[i].color[0];
          colors[i * 3 + 1] = sorted[i].color[1];
          colors[i * 3 + 2] = sorted[i].color[2];
        }
        gl.uniform1i(gl.getUniformLocation(prog, 'u_stopCount'), sorted.length);
        gl.uniform1fv(gl.getUniformLocation(prog, 'u_stopPos'), positions);
        gl.uniform3fv(gl.getUniformLocation(prog, 'u_stopColor'), colors);
        break;

      case 'colorAdjust':
        gl.uniform1f(gl.getUniformLocation(prog, 'u_brightness'), p.brightness);
        gl.uniform1f(gl.getUniformLocation(prog, 'u_contrast'), p.contrast);
        gl.uniform1f(gl.getUniformLocation(prog, 'u_saturation'), p.saturation);
        break;

      case 'hueShift':
        gl.uniform1f(gl.getUniformLocation(prog, 'u_shift'), p.shift);
        break;

      case 'lumThreshold':
        gl.uniform1f(gl.getUniformLocation(prog, 'u_threshold'), p.threshold);
        gl.uniform1f(gl.getUniformLocation(prog, 'u_range'), p.range);
        break;

      case 'channelMixer':
        gl.uniform3fv(gl.getUniformLocation(prog, 'u_redMix'), p.redMix);
        gl.uniform3fv(gl.getUniformLocation(prog, 'u_greenMix'), p.greenMix);
        gl.uniform3fv(gl.getUniformLocation(prog, 'u_blueMix'), p.blueMix);
        break;

      case 'chromaKey':
        gl.uniform3fv(gl.getUniformLocation(prog, 'u_keyColor'), p.keyColor);
        gl.uniform1f(gl.getUniformLocation(prog, 'u_threshold'), p.threshold);
        gl.uniform1f(gl.getUniformLocation(prog, 'u_smoothness'), p.smoothness);
        break;
    }
  }

  _blitTexture(tex) {
    const gl = this.gl;
    const prog = this.programs.passthrough;
    gl.useProgram(prog);
    this._bindQuad(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Legacy compatibility: convert old settings format to stack
  legacySettingsToStack(settings) {
    const stack = [];

    if (settings.blurOn !== false) {
      stack.push(createStage('blur', {
        radius: settings.blurRadius ?? 3,
        sigma: settings.blurSigma ?? 0.12,
      }));
    }

    if (settings.edgeOn !== false) {
      stack.push(createStage('sobel', {
        threshold: settings.edgeThreshold ?? 0.15,
        thickness: settings.edgeThickness ?? 1,
        strength: settings.edgeStrength ?? 1.0,
        color: settings.edgeColor ?? [1, 1, 0],
        source: settings.edgeSource ?? 2,
        mode: settings.edgeMode ?? 1,
      }));
    }

    if (settings.rampOn !== false) {
      stack.push(createStage('colorramp', {
        driver: settings.rampDriver ?? 0,
        mix: settings.rampMix ?? 1.0,
        contrast: settings.rampContrast ?? 1.0,
        stops: settings.rampStops ?? [
          { pos: 0.0, color: [0.04, 0.06, 0.25] },
          { pos: 0.35, color: [0.25, 0.35, 0.65] },
          { pos: 0.65, color: [0.75, 0.70, 0.35] },
          { pos: 1.0, color: [1.0, 0.95, 0.55] },
        ],
      }));
    }

    if (settings.brightness !== 0 || settings.contrast !== 1 || settings.saturation !== 1) {
      stack.push(createStage('colorAdjust', {
        brightness: settings.brightness ?? 0,
        contrast: settings.contrast ?? 1,
        saturation: settings.saturation ?? 1,
      }));
    }

    return stack;
  }
}

// Expose globally
if (typeof window !== 'undefined') {
  window.VisionFilter = VisionFilter;
  window.createStage = createStage;
}
if (typeof module !== 'undefined') {
  module.exports = { VisionFilter, createStage };
}
