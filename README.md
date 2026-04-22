# RS Vision Assist Overlay

Real-time contrast and outline overlay for RuneScape, tuned for Cone-Rod Dystrophy. Runs the same WebGL filter stack as the playground, but against a live capture of the RuneLite (or any) window.

## ⚠️ CRITICAL: RuneLite must NOT be in Always On Top mode (In the "Runelite" Settings > Always Ontop)

**This is the number-one reason the overlay appears to "do nothing."**

It bypasses the desktop compositor. When the game is set to this, *no* overlay from *any* other application can appear on top of it, not this one, not Discord, not OBS's game-capture-window, nothing.

In RuneLite:
- Open the **Stretched mode** plugin settings (if using).
- Under the main RuneLite config, check that the window is in **Resizable** or **Fixed** mode, NOT fullscreen.
- If you're using the "Fullscreen" plugin, disable it.
- Alternatively, use **borderless windowed mode** (a window that fills the screen but is still a window). This lets overlays appear on top.

Verify this first before debugging anything else.

## Setup

Requires Node.js 18+ and npm.

```
npm install
npm start
```

First run will compile `node-window-manager` native bindings (needs build tools on Windows, `windows-build-tools` or Visual Studio Build Tools with the "Desktop development with C++" workload).

## Usage

1. **Launch RuneLite** first. Get it to the screen/position your friend wants to play at.
2. **Start this app** with `npm start`. The Control Panel window opens.
3. **Refresh window list**, then pick the RuneLite window from the `Capture Source` dropdown. A thumbnail appears so you can confirm you picked the right one.
4. **Start overlay**. A borderless window appears. It is click-through, so RuneLite still gets your mouse/keyboard.
5. **Position the overlay** one of two ways:
   - **Manual bounds**: type in X/Y/W/H and hit Apply. Useful if the game is in a fixed spot.
   - **Track window**: pick the RuneLite window from the track dropdown and hit Track. The overlay will follow RuneLite around if it's moved or resized.
6. **Tune filters** with the same controls as the playground. Changes push to the overlay in real time.
7. **Ctrl+Shift+F1** toggles overlay visibility globally, works even while the game has focus.

## How it works

- `desktopCapturer` grabs the target window as a 60fps video stream.
- The overlay's WebGL2 pipeline runs the bilateral-blur + Sobel + color-ramp shader on every frame.
- The overlay window is `alwaysOnTop + click-through`, so visually it replaces the game but input falls through.
- `node-window-manager` polls the RuneLite window at 10Hz to keep the overlay aligned.

## Performance

Expect 55-60fps at 1080p on anything with an integrated GPU from the last 5 years. 4K will need a discrete GPU. If FPS drops, reduce `Blur Radius` first (bilateral filter is the most expensive stage).

## Troubleshooting

**Black overlay with no image.** Source probably wasn't set. Re-pick the source in the dropdown; setting the source after the overlay is open should work.

**Overlay doesn't click through.** On Windows 10/11 `setIgnoreMouseEvents` with `{forward: true}` is used. If your system has issues, Ctrl+Shift+F1 hides the overlay instantly.

**Tracking doesn't work / track list empty.** `node-window-manager` failed to install or load. App still works fine with manual bounds.

**Overlay appears behind fullscreen game.** Run RuneLite in **windowed** or **borderless windowed** mode, not exclusive fullscreen. The overlay can't appear over exclusive fullscreen on Windows without a DWM hook (out of scope for Electron).

**Capture is mirrored / wrong orientation.** The shader's `UNPACK_FLIP_Y_WEBGL` flag might need flipping, edit `overlay.html` and change the `true` in `filter.uploadSource(video, true)` to `false`.

**Anti-cheat / bans.** This tool does not read RuneLite memory, inject code into its process, or automate input. It only captures pixels via the OS screen-capture API, the same way OBS or Discord screen-share does. That said, Jagex's stance on any third-party tool is worth verifying before heavy use.

## Next steps

If this works for your friend, the sensible progression is:

1. Package as a Windows installer via `npm run build` (produces a portable exe).
2. Add a "save/load preset" menu in the panel so he can bookmark settings for specific content (skilling vs PvM vs maze events).
3. Eventually port the shader to a RuneLite plugin once you know which filter configuration actually works for his vision in practice.

## Bundling default presets for distribution

Presets are stored in the user's Electron `userData` directory (`%APPDATA%/RS Vision Assist/presets.json` on Windows). On first launch, if the user has no presets file yet, the app checks for a `default-presets.json` file next to `main.js` and seeds from it.

To ship a build that opens with your friend's preferred preset already loaded:

1. Tune the filter to exactly what he wants.
2. Click "Save current" in the My Presets section, name it (e.g., "Travis Default").
3. Click the ☆ next to it to mark it as the default.
4. The preset file is now at `%APPDATA%/RS Vision Assist/presets.json`. Open it, copy its contents to `src/default-presets.json` in your source tree.
5. Rebuild. New users will get your defaults on first launch.

The file structure is:
```json
{
  "presets": {
    "Travis Default": { "state": {...}, "rampStops": [...] }
  },
  "defaultPreset": "Travis Default"
}
```
