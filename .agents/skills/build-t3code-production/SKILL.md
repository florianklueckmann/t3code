---
name: build-t3code-production
description: Build and verify usable T3 Code desktop production artifacts on macOS, especially Apple Silicon. Use when asked for a production build, release DMG, installable ZIP, packaged desktop app, or when desktop packaging fails during macOS icon generation.
---

# Build T3 Code Production

Create a current, usable macOS desktop artifact from this checkout and report its exact path, architecture, size, checksum, and installation guidance.

## Workflow

1. Check the repository state before building:

   ```bash
   git status --short --branch
   uname -m
   test -d node_modules
   ```

   Do not discard local changes. Use the current branch unless the user names another one. On Apple Silicon, target `arm64`.

2. Build the production web, server, and Electron inputs:

   ```bash
   vp run build:desktop
   ```

3. Package the native macOS artifact:

   ```bash
   vp run dist:desktop:dmg:arm64
   ```

   The packaging command normally runs the build again. If step 2 just passed and only packaging is being retried, set `T3CODE_DESKTOP_SKIP_BUILD=1`.

4. If macOS 26 reports `iconutil ... Invalid Iconset`, use the bundled compatibility path. `/usr/bin/iconutil` on the affected host rejects even iconsets extracted from an existing valid ICNS, so do not regenerate or replace repository branding assets.

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

   The `iconutil` shim only handles the packaging command's `-o` destination and copies the prebuilt production ICNS there. Keep the generated files in `/private/tmp`; do not edit tracked assets or the packaging script for this host-specific workaround.

5. Verify the output and report it:

   ```bash
   ls -lh release/T3-Code-*-arm64.dmg release/T3-Code-*-arm64.zip
   shasum -a 256 release/T3-Code-*-arm64.dmg release/T3-Code-*-arm64.zip
   file release/T3-Code-*-arm64.dmg release/T3-Code-*-arm64.zip
   git status --short --branch
   ```

   The expected outputs are an arm64 DMG and matching ZIP under `release/`, plus blockmaps and `builder-debug.yml`. Give the user the DMG path for installation and the ZIP path for direct extraction. Do not claim runtime smoke testing unless it was explicitly requested and performed.

## Build Notes

- The current desktop artifact script is `scripts/build-desktop-artifact.ts`.
- The normal Apple Silicon commands are `vp run build:desktop` and `vp run dist:desktop:dmg:arm64`.
- Staged production dependency installation may need registry/network access. If the sandbox reports npm `ENOTFOUND`, retry the same command with the required network permission; do not interpret that as a code or dependency failure.
- Packaging emits non-fatal bundle-size, sourcemap, and plugin-timing warnings. Report them only if they prevent artifact creation.
