# AGENT.md — Shelly Device Scripting

Guidelines for AI agents working on scripts in this repository. These scripts run on **Shelly Gen2/Gen3 devices** (Plus, Pro, BLU series) via the device's built-in **mJS** JavaScript engine. Use case here: **aquarium automation** (e.g., 0–10V light dimming via `aquarium.white.js`).

---

## 1. Language & Runtime Constraints (mJS)

Scripts run in **mJS** — a restricted JavaScript subset. NOT full JavaScript.

| Feature | Status | Notes |
|---|---|---|
| `var` | ✅ | Preferred variable declaration |
| `let` / `const` | ⚠️ | Supported in newer firmware; `var` is safest |
| Functions, closures | ✅ | Fine to use |
| `Date` object | ❌ | Use `Timer` and schedules instead; epoch via `Sys.GetStatus().unixtime` |
| `async/await`, Promises | ❌ | Use callback-style APIs |
| `setTimeout` / `setInterval` | ❌ | Use `Timer.set()` / `Timer.clear()` |
| `fetch`, `XMLHttpRequest` | ❌ | Use `Shelly.call("HTTP.Request", ...)` |
| Regex | ⚠️ | Limited/absent depending on firmware |
| `JSON.stringify` / `JSON.parse` | ✅ | Payload size limits (~4KB for some RPC results) |
| `Math` | ⚠️ | Only `abs, ceil, cos, exp, floor, log, pow, random, round, sin, sqrt, tan` |
| Filesystem access | ❌ | Use **KVS** for persistence (`KVS.Set` / `KVS.Get`) |
| Loops | ✅ | But **never block** — device watchdog reboots on busy-waiting |

**Script limits:** ~8 KB source per script (more on recent firmware), limited free RAM. Keep scripts small; split logic across scripts or store state in KVS.

---

## 2. Core APIs

### `Shelly.call(method, params, callback)`

The RPC interface to everything on the device.

```js
Shelly.call("Light.Set", { id: 0, on: true, brightness: 70 }, function (result, error_code, error_message) {
  if (error_code !== 0) {
    print("RPC failed: " + error_message);
    return;
  }
  print("OK");
});
```

Always check the error code in callbacks. RPC methods of interest:

| Method | Purpose |
|---|---|
| `Switch.Set`, `Switch.GetStatus` | Relays |
| `Light.Set`, `Light.GetStatus` | Dimmers / 0–10V lights (brightness 0–100) |
| `Cover.SetPosition`, `Cover.GoToPosition` | Roller shutters |
| `HTTP.Request` / `HTTP.Get` | Outbound HTTP calls |
| `KVS.Set` / `KVS.Get` / `KVS.Delete` | Persistent key-value storage |
| `Schedule.Create` / `Schedule.List` / `Schedule.Delete` | Cron-based schedules |
| `Script.Eval`, `Script.List`, `Script.Stop` | Script management |
| `Sys.GetStatus`, `Sys.GetConfig` | Device info, time, uptime |
| `Shelly.GetDeviceInfo` | Device identity |

### `Timer`

```js
var timerId = Timer.set(60000, true, function () { /* runs every 60s */ });
Timer.set(5000, false, function () { /* runs once after 5s */ });
Timer.clear(timerId);
```

### Global Shelly helpers

```js
Shelly.getCurrentScriptId();          // id of the currently running script
Shelly.addStatusHandler(function (status) {});   // component status changes
Shelly.addEventHandler(function (event, userData) {}); // events (inputs, schedules, etc.)
```

---

## 3. Schedules & Cron

Timespec is a **6-field cron: `sec min hour day month weekday`** — seconds come FIRST (unlike standard cron).

```js
// 11:45:00 AM every day:
Shelly.call("Schedule.Create", {
  enable: true,
  timespec: "0 45 11 * * *",
  comment: "FadeIn_1145",
  calls: [{
    method: "Script.Eval",
    params: { id: Shelly.getCurrentScriptId(), code: "startFade(...);" }
  }]
});
```

- Use the `comment` field as a **dedup key** — always `Schedule.List` first and skip creation if it already exists (idempotent setup on boot, as in `aquarium.white.js`).
- `Script.Eval` executes code in the script's context, so scheduled calls can reference script functions and `CONFIG`.

---

## 4. Code Conventions (matching this repo)

1. **`CONFIG` object at the top** — all user-tunable values (component IDs, cron strings, durations, brightness levels) live there. No magic numbers in logic.
2. **Idempotent setup** — `setupSchedules()` runs at boot and creates missing schedules only.
3. **Callback-safe state** — module-level `var`s for state; guard against overlapping runs (e.g., clear the previous `Timer` before starting a new fade).
4. **Clamp values** — always clamp to the component's range (e.g., brightness 0–100) before RPC.
5. **`print()` for logs** — visible in the WebUI script editor and via `Script.GetStatus`.
6. **Comments in the file** describe intent (what/why), including the schedule times in human-readable form.

---

## 5. Testing & Deployment

**WebUI (easiest):** `http://<device-ip>` → Scripts → create/edit → Save → Run.

**RPC from terminal:**

```bash
# Upload a script
curl -u admin:PASSWORD -X POST \
  -F 'name=aquarium.white' \
  --data-binary @aquarium.white.js \
  http://192.168.1.42/rpc/Script.Create

# Run / stop / list
curl -u admin:PASSWORD -d '{"id":1}' http://192.168.1.42/rpc/Script.Start
curl -u admin:PASSWORD -d '{"id":1}' http://192.168.1.42/rpc/Script.Stop
curl -u admin:PASSWORD http://192.168.1.42/rpc/Script.List

# Read script logs
curl -u admin:PASSWORD -d '{"id":1}' http://192.168.1.42/rpc/Script.GetStatus
```

- Firmware: 1.0.0+ required for Gen2 scripting; check `Sys.GetStatus` for version.
- When renaming/updating schedules, delete old ones by id (`Schedule.Delete`) or they accumulate.
- Script auto-start: enable per-script via WebUI (runs on boot) — verify this is on for scheduled automations.

---

## 6. Common Pitfalls Checklist

- [ ] Cron timespec has **6 fields, seconds first** (`"0 0 20 * * *"` = 20:00:00 daily, *not* `"0 20 * * *"`).
- [ ] Callbacks are async — never assume an RPC result is available on the next line.
- [ ] `Light.Set` brightness is **0–100**, not 0–255.
- [ ] `Timer.set(ms, repeat, fn)` — always keep the returned id to `Timer.clear()` later.
- [ ] No `Date` object — never attempt time math with `Date`; use schedules or `unixtime` from `Sys.GetStatus`.
- [ ] Never use blocking loops (`while (true)`) — watchdog will reboot the device.
- [ ] KVS is the only persistence across reboots — script-level `var`s reset on reboot.
- [ ] JSON-RPC payloads are size-limited; chunk large data transfers.
