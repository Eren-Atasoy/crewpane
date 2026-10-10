---
name: motion-studio
description: Deterministic programmatic animation and motion graphics. Rules: frame is a pure function of frame number (no timers/randomness), embedded fonts, fixed scene dimensions, ffmpeg H.264 with explicit pixel aspect ratio. Headless smoke test counters and seamless loop checks.
license: MIT
metadata:
  crewpane.origin: builtin
  crewpane.author: CrewPane Motion Studio
  crewpane.status: published
---

# Motion Studio Skill

Deterministic programmatic animation, frame-by-frame rendering, and video synthesis.

## Core Principles & Determinism Rules

1. **Pure Function of Frame Index**:
   - `render(frameIndex, totalFrames)` must be completely deterministic.
   - **Forbidden:** `Math.random()`, `Date.now()`, `performance.now()`, `setTimeout()`, `setInterval()`, `requestAnimationFrame()`, or CSS keyframe animations tied to wall-clock time.
   - For procedural variation, use a deterministic seeded PRNG (e.g. Mulberry32, splitmix32) initialized with a fixed seed and `frameIndex`.

2. **Fixed Scene Dimensions**:
   - Explicit canvas or SVG dimensions (e.g., `1920x1080` for 16:9, `1080x1920` for 9:16 vertical, `1080x1080` for square).
   - Viewbox and pixel dimensions must match precisely without fractional pixel blur.

3. **Embedded Fonts**:
   - Never rely on system-installed or network-fetched web fonts during rendering.
   - Fonts must be embedded directly as base64 WOFF2 in `@font-face` or converted to static SVG paths to prevent layout jitter, missing glyphs, or network race conditions.

4. **FFmpeg Video Export**:
   - Encode with H.264 video codec (`-c:v libx264`).
   - Explicit pixel format: `-pix_fmt yuv420p` for universal player compatibility.
   - Explicit pixel aspect ratio (SAR 1:1): `-vf "setsar=1"`.
   - Fixed framerate (e.g., 30 fps or 60 fps) without dropped frames: `-r 30`.

## Automated Quality Verification Checks

These checks are designed to hook directly into the **Goal Gate** (`checks: ["node scripts/check-motion.cjs"]`):

### 1. Headless Smoke Test Counters
All counters must evaluate to **0**:
- **Runtime Errors**: Uncaught exceptions, NaN / Infinity coordinate transforms.
- **Text Overflow**: Any text bounding box protruding outside the scene viewport.
- **Text Collision**: Involuntary intersections between separate text layers.
- **Asset Load Failures**: 404s, unparsed SVGs, missing image textures.

### 2. Seamless Loop Check (Seam Check)
For looping animations:
- Frame `0` must be identical to Frame `totalFrames - 1` (or `totalFrames` if closed-loop).
- Pixel-by-pixel diff must yield 0 delta (or mean squared error < 0.001 for lossy compressions).

## Goal Gate Integration Example

When delegating a motion task, specify in the `goal` object:
```json
{
  "goal": {
    "checks": [
      "node scripts/check-motion-smoke.cjs",
      "node scripts/check-motion-seam.cjs"
    ],
    "maxRounds": 3,
    "abortIfNoProgress": 2
  }
}
```
