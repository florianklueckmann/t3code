---
name: build-t3code-production
description: Build and verify usable T3 Code desktop production artifacts on macOS, especially Apple Silicon, including host-tool compatibility for SVG DMG backgrounds and ICNS generation. Use when asked for a production build, release DMG, installable ZIP, packaged desktop app, or when macOS packaging fails.
---

# Build T3 Code Production

Create a current, usable macOS desktop artifact from this checkout and report its exact path, architecture, size, checksum, and installation guidance.

## Workflow

1. Check the repository state before building:

   ```bash
   git status --short --branch
   uname -m
   test -d node_modules
   test -f assets/prod/black-macos-1024.png
   command -v qlmanage
   ```

   Do not discard local changes. Use the current branch unless the user names another one. On Apple Silicon, target `arm64`. If `node_modules` is missing, run `vp i` before continuing.

2. Build the production web, server, and Electron inputs:

   ```bash
   vp run build:desktop
   ```

3. Package the native macOS artifact:

   Use the bundled macOS compatibility wrappers for packaging. They delegate ordinary PNG work to `/usr/bin/sips`, rasterize SVG DMG backgrounds through Quick Look, and provide a deterministic ICNS when the host `iconutil` rejects valid iconsets. This avoids the two known macOS host failures: `sips ... Cannot extract image` for the SVG backgrounds and `iconutil ... Invalid Iconset`.

   ```bash
   icon_tmp="$(mktemp -d /private/tmp/t3code-prod-icon.XXXXXX)"
   node .agents/skills/build-t3code-production/scripts/build-prod-icns.mjs \
     --source assets/prod/black-macos-1024.png \
     --output "$icon_tmp/production.icns"
   T3CODE_PRODUCTION_ICNS="$icon_tmp/production.icns" \
     PATH="$PWD/.agents/skills/build-t3code-production/scripts:$PATH" \
     T3CODE_DESKTOP_SKIP_BUILD=1 \
     vp run dist:desktop:dmg:arm64
   ```

   The `scripts/sips` wrapper only intercepts SVG input with an explicit `--out` and `-z` size; every other call delegates to `/usr/bin/sips`. Quick Look first emits a square thumbnail, then `/usr/bin/sips` resamples it to the requested `540×380` or `1080×760` canvas. The `iconutil` shim copies the prebuilt production ICNS to the requested `-o` destination. Keep all generated files in `/private/tmp`; do not edit tracked assets or the packaging script. If Quick Look reports a sandbox initialization error, rerun the packaging command with the required local elevated permission.

4. Verify the output and report it:

   ```bash
   version="$(node -p "require('./apps/desktop/package.json').version")"
   dmg="release/T3-Code-${version}-arm64.dmg"
   zip="release/T3-Code-${version}-arm64.zip"
   ls -lh "$dmg" "$zip" "$dmg.blockmap" "$zip.blockmap" release/builder-debug.yml
   shasum -a 256 "$dmg" "$zip"
   file "$dmg" "$zip"
   verify_tmp="$(mktemp -d /private/tmp/t3code-artifact-verify.XXXXXX)"
   unzip -q "$zip" -d "$verify_tmp"
   app_binary="$(find "$verify_tmp" -path '*/Contents/MacOS/*' -type f | head -n 1)"
   file "$app_binary"
   git status --short --branch
   ```

   The expected outputs are a current-version arm64 DMG and matching ZIP under `release/`, plus version-matched blockmaps and `builder-debug.yml`. Confirm that the extracted executable reports `Mach-O 64-bit executable arm64`. Give the user the exact DMG path for installation and ZIP path for direct extraction. Do not claim runtime smoke testing unless it was explicitly requested and performed.

## Build Notes

- The current desktop artifact script is `scripts/build-desktop-artifact.ts`.
- The normal Apple Silicon commands are `vp run build:desktop` and `vp run dist:desktop:dmg:arm64`.
- The packaging command stages SVG backgrounds and calls `sips`; keep the bundled `scripts/sips` first in `PATH` for reliable macOS packaging.
- Staged production dependency installation may need registry/network access. If the sandbox reports npm `ENOTFOUND`, retry the same command with the required network permission; do not interpret that as a code or dependency failure.
- Packaging emits non-fatal bundle-size, sourcemap, and plugin-timing warnings. Report them only if they prevent artifact creation.
