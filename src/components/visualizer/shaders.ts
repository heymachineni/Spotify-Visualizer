/**
 * GLSL shaders for the Spotify visualizer.
 * Vertex: calm vertical + depth field; only subtle X drift (no wide lateral
 * wrap). Fragment: precomposed card atlas (cover + label + glass). Pick:
 * same atlas for alpha, encodes `aInstanceId` in RGB.
 */

export const visualizerVertexShader = /* glsl */ `
varying vec2 vUv;

attribute vec3 aInitialPosition;
attribute float aMeshSpeed;
attribute vec4 aTextureCoords;
attribute float aInstanceId;

uniform float uTime;
uniform vec2 uMaxXdisplacement;
uniform vec2 uDrag;

uniform float uSpeedY;
uniform float uScrollY;

// Proximity + selection (smoothed on CPU)
uniform vec2 uPointerNdc;
uniform float uPointerBlend;
uniform float uSelectedId;
uniform float uSelectStrength;

varying float vVisibility;
varying vec4 vTextureCoords;
varying float vInstanceId;
varying float vLightMul;
varying float vBloomSharp;

float remap(float value, float originMin, float originMax) {
  return clamp((value - originMin) / (originMax - originMin), 0.0, 1.0);
}

void main() {
  vec3 newPosition = position + aInitialPosition;

  float maxX = uMaxXdisplacement.x;
  float maxY = uMaxXdisplacement.y;

  float maxYoffset = distance(aInitialPosition.y, maxY);
  float minYoffset = distance(aInitialPosition.y, -maxY);

  // Vertical wrap + drag (keeps continuous vertical field)
  float yDisplacement = mod(minYoffset - uDrag.y, maxYoffset + minYoffset) - minYoffset;

  // No wide lateral mod() sweep. Only subtle organic X drift.
  float xDrift =
    sin(uTime * 0.095 + aInitialPosition.x * 0.012) * maxX * 0.022
    + sin(uTime * 0.071 + aInitialPosition.y * 0.01 + aMeshSpeed) * maxX * 0.012;
  newPosition.x += xDrift;
  newPosition.x -= uDrag.x * 0.1;

  newPosition.y += yDisplacement;

  float maxZ = 8.0;
  float minZ = -18.0;
  float zSpan = maxZ - minZ;

  float maxZoffset = distance(aInitialPosition.z, maxZ);
  float minZoffset = distance(aInitialPosition.z, minZ);

  float zDisplacement = mod(uScrollY + minZoffset, maxZoffset + minZoffset) - minZoffset;
  newPosition.z += zDisplacement;

  // Floor far-card XY so perspective does not make tiny splinters (min 0.6 of mid-depth)
  float tDep = clamp((newPosition.z - minZ) / zSpan, 0.0, 1.0);
  float xyScale = max(tDep, 0.6);
  newPosition.x *= xyScale;
  newPosition.y *= xyScale;

  // Instance center in local space (independent of vertex corner offset)
  vec3 centerPos = newPosition - position;
  float hov = 0.0;
  float farW = 0.0;
  if (uPointerBlend > 0.001) {
    vec4 mc = modelMatrix * instanceMatrix * vec4(centerPos, 1.0);
    vec4 vc = viewMatrix * mc;
    vec4 pc = projectionMatrix * vc;
    vec2 ndcC = pc.xy / max(abs(pc.w), 0.0001);
    float distNdc = length(ndcC - uPointerNdc);
    hov = (1.0 - smoothstep(0.0, 0.3, distNdc)) * uPointerBlend;
    farW = smoothstep(0.12, 0.5, distNdc) * uPointerBlend;
  }

  float br = 1.0;
  br *= mix(0.92, 1.0, 1.0 - farW * 0.4);
  br *= mix(1.0, 1.12, hov * 0.9);

  float isSel = 0.0;
  if (uSelectedId >= 0.0 && uSelectStrength > 0.001) {
    isSel = 1.0 - step(0.5, abs(aInstanceId - uSelectedId));
  }
  br *= mix(1.0, 0.9, (1.0 - isSel) * uSelectStrength);
  br *= mix(1.0, 1.1, isSel * uSelectStrength);

  float s = 1.0 + 0.03 * hov + 0.055 * isSel * uSelectStrength;
  newPosition *= s;
  newPosition.z += 0.12 * hov + 0.22 * isSel * uSelectStrength;

  vLightMul = br;
  vBloomSharp = isSel * uSelectStrength;
  vVisibility = remap(newPosition.z, minZ, minZ + 5.0);

  vec4 modelPosition = modelMatrix * instanceMatrix * vec4(newPosition, 1.0);
  vec4 viewPosition = viewMatrix * modelPosition;
  vec4 projectedPosition = projectionMatrix * viewPosition;
  gl_Position = projectedPosition;

  vUv = uv;
  vTextureCoords = aTextureCoords;
  vInstanceId = aInstanceId;
}
`;

export const visualizerFragmentShader = /* glsl */ `
varying vec2 vUv;
varying float vVisibility;
varying vec4 vTextureCoords;
varying float vInstanceId;
varying float vLightMul;
varying float vBloomSharp;

uniform sampler2D uAtlas;
uniform sampler2D uBlurryAtlas;

void main() {
  float xStart = vTextureCoords.x;
  float xEnd = vTextureCoords.y;
  float yStart = vTextureCoords.z;
  float yEnd = vTextureCoords.w;

  vec2 atlasUV = vec2(
    mix(xStart, xEnd, vUv.x),
    mix(yStart, yEnd, 1.0 - vUv.y)
  );

  vec4 color = texture2D(uAtlas, atlasUV);
  vec4 bloomed = texture2D(uBlurryAtlas, atlasUV);
  float bMix = mix(0.28, 0.16, vBloomSharp);
  color.rgb = mix(
    color.rgb,
    color.rgb + bloomed.rgb * 0.22,
    bMix
  );
  color.rgb *= vLightMul;

  if (color.a < 0.02) discard;

  color.a *= vVisibility;
  color.r = min(color.r, 1.0);
  color.g = min(color.g, 1.0);
  color.b = min(color.b, 1.0);

  gl_FragColor = color;
}
`;

/**
 * Off-screen pick. Uses atlas alpha so rounded cards match; encodes
 * aInstanceId in RGB with A = 1.
 */
export const visualizerPickFragmentShader = /* glsl */ `
varying vec2 vUv;
varying float vVisibility;
varying float vInstanceId;
varying vec4 vTextureCoords;
varying float vLightMul;
varying float vBloomSharp;

uniform sampler2D uAtlas;

void main() {
  float xStart = vTextureCoords.x;
  float xEnd = vTextureCoords.y;
  float yStart = vTextureCoords.z;
  float yEnd = vTextureCoords.w;

  vec2 atlasUV = vec2(
    mix(xStart, xEnd, vUv.x),
    mix(yStart, yEnd, 1.0 - vUv.y)
  );

  if (texture2D(uAtlas, atlasUV).a < 0.04) discard;
  if (vVisibility < 0.05) discard;

  float id = vInstanceId;
  float r = mod(id, 256.0) / 255.0;
  float g = mod(floor(id / 256.0), 256.0) / 255.0;
  float b = mod(floor(id / 65536.0), 256.0) / 255.0;
  gl_FragColor = vec4(r, g, b, 1.0);
}
`;
