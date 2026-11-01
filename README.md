# Shelly Aquarium Lighting

Automated aquarium lighting scripts for **Shelly 0-10V Dimmer** devices (Gen2, mJS scripting engine). One device per light; each script is deployed to its own device and runs fully standalone.

## Lights & Scripts

| Script | Device | Purpose |
|---|---|---|
| [`aquarium.white.js`](aquarium.white.js) | White light dimmer | Daylight: fade-in 11:45 → 70%, fade-out at 20:00 |
| [`aquarium.color.js`](aquarium.color.js) | Accent light dimmer | Sunrise/sunset intensity simulation |
| [`aquarium.blue.js`](aquarium.blue.js) | Moonlight (actinic) dimmer | Evening moonlight 20:00 → 22:00 at 40% |

## Daily Timeline

```
11:15–11:45  Accent ramp up to 100%, then off      (sunrise)
11:45–12:00  White fade-in: 0% → 70%               (daylight starts)
20:00–20:15  White fade-out: 70% → 0%, off         (daylight ends)
20:00–20:30  Accent ramp down to 0%, off           (sunset)
20:00–20:15  Blue moonlight fade-in: 0% → 40%      (moonlight starts)
21:45–22:00  Blue moonlight fade-out: 40% → 0%     (moonlight ends)
```

## Features (all scripts)

- **Idempotent schedule setup** — schedules are created at boot only if missing (dedup by comment key), safe across reboots and re-deploys.
- **No brightness jumps** — fades start from the *actual* current level (read via `Light.GetStatus`), so manual light changes don't cause jumps.
- **Reboot recovery** — fade state is persisted to KVS on every step; after a reboot the interrupted fade resumes automatically.
- **Error logging** — failed RPC calls are logged with method, message and error code instead of failing silently.
- **Rounding-drift free** — the final step snaps exactly to the target brightness before turning the light off.

## Installation

1. Open the WebUI of each dimmer: `http://<device-ip>`
2. Go to **Scripts** → **Create script**, name it (e.g., `aquarium.white`), paste the matching script, **Save**.
3. Enable **Run at boot** for the script (checkbox in the script list).
4. **Start** the script once — it creates its schedules on the device.

Repeat for each device with its matching script. Alternatively upload via RPC:

```bash
curl -u admin:PASSWORD -X POST \
  --data-binary @aquarium.white.js \
  http://192.168.1.42/rpc/Script.Create
```

## Configuration

All tunable values live in the `CONFIG` object at the top of each script:

- `id` — Light component ID (always `0` on a 0-10V dimmer)
- `cron` — schedule timespec (**6-field, seconds first**, e.g., `"0 45 11 * * *"` = 11:45:00 daily)
- `durationMin` — fade duration in minutes (one step per minute)
- `endBrightness` — target brightness in percent (0–100)
- `kvsKey` — KVS key for fade state (per-device, no conflicts across devices)

If you change schedule times, delete the old schedules first (WebUI → Schedules, or `Schedule.Delete`), then restart the script — the comment keys are used to detect existing schedules.

## Troubleshooting

| Symptom | Check |
|---|---|
| Schedules fire but nothing happens | Script "Run at boot" disabled, or script deleted/disabled on the device |
| Light jumps at schedule time | Expected behavior was fixed — make sure the deployed script reads `Light.GetStatus` (all current scripts do) |
| Light stuck after reboot mid-fade | Script auto-start disabled — KVS resume only works if the script runs at boot |
| No logs visible | Use WebUI script editor logs, or `curl -u admin:PASSWORD -d '{"id":N}' http://<ip>/rpc/Script.GetStatus` |

## Notes

- mJS is a restricted JavaScript subset: no `Date`, no `async/await`, no `setTimeout` (use `Timer.set`), KVS for persistence. See [`AGENT.md`](AGENT.md) for full constraints, API reference, and pitfalls checklist.
- Brightness on `Light.Set` is **0–100**, not 0–255.
