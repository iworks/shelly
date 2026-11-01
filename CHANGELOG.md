# Changelog

All notable changes to the aquarium lighting scripts will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) per script.

## [Unreleased]

### Planned
- Midday "full daylight" hold schedule for the white light (single source of truth for the 70% level).

## [1.1.0] - 2026-11-01

### Added
- `aquarium.color.js` — accent light script for a standalone 0-10V dimmer:
  sunrise ramp 11:15–11:45 (0→100%, then off) and sunset ramp 20:00–20:30
  (down to 0%, off). Brightness-only simulation of color transitions.
- `aquarium.blue.js` — moonlight/actinic script: fade-in 20:00–20:15 (0→40%),
  fade-out 21:45–22:00 (40→0%, off).
- All scripts: fade now starts from the **actual** light level (`Light.GetStatus`)
  instead of a hardcoded start brightness — no jumps when the light was
  manually changed.
- All scripts: fade state persisted to KVS on every step; interrupted fades
  resume automatically after a reboot.
- All scripts: `rpc()` wrapper with error logging (method, message, code)
  for all `Shelly.call` usage, including `Schedule.List`.
- All scripts: final fade step snaps exactly to the target brightness,
  eliminating rounding drift.
- `AGENT.md` — Shelly mJS scripting guide (runtime constraints, API reference,
  conventions, deployment, pitfalls checklist).
- `README.md` and `CHANGELOG.md`.

### Changed
- `aquarium.color.js` was initially written as an RGB color-ramp script;
  redesigned for a single-channel 0-10V dimmer (brightness-only).
- `aquarium.blue.js` — `CONFIG.id` set to `0` (each device is a standalone
  single-channel dimmer, not a channel on a shared device).
- `aquarium.white.js` — `CONFIG.morning/evening.startBrightness` removed
  (superseded by reading the actual level).

### Notes
- Three standalone Shelly 0-10V dimmers: one script per device, all with
  `Light` component id `0`. Schedules are created locally per device.
- All scripts require **"Run at boot"** enabled — boot recovery (KVS resume)
  and schedule (re)creation depend on it.

## [1.0.0] - 2026-10-31

### Added
- `aquarium.white.js` — initial white light script: fade-in at 11:45
  (0→70% in 15 min), fade-out at 20:00 (70→0% in 15 min, then off).
  Idempotent schedule setup with comment dedup keys (`FadeIn_1145`,
  `FadeOut_2000`), 1-minute fade steps via `Timer.set`.
