// Script configuration
var CONFIG = {
  id: 0, // Light component ID in Shelly Plus (usually 0)
  kvsKey: "aquarium_fade_state", // KVS key used to persist fade state across reboots

  // Morning: from 11:45 for 15 minutes up to 70%
  morning: {
    cron: "0 45 11 * * *", // 11:45 AM every day
    durationMin: 15,       // duration in minutes
    endBrightness: 70
  },

  // Evening: from 20:00 for 15 minutes down to 0% and turn off
  evening: {
    cron: "0 0 20 * * *",  // 08:00 PM every day
    durationMin: 15,       // duration in minutes
    endBrightness: 0
  }
};

// Helper variables for the fading process timer
var fadeTimer = null;
var currentBrightness = 0;
var targetBrightness = 0;
var stepValue = 0;
var stepsRemaining = 0;
var turnOffAtEnd = false;

// RPC wrapper with error logging (fails loudly instead of silently)
function rpc(method, params, callback) {
  Shelly.call(method, params, function (result, errorCode, errorMessage) {
    if (errorCode !== 0) {
      print("RPC " + method + " failed: " + errorMessage + " (code " + errorCode + ")");
      return;
    }
    if (callback) callback(result);
  });
}

// Persist the current fade state so an interrupted fade can be resumed after reboot
function saveFadeState() {
  rpc("KVS.Set", {
    key: CONFIG.kvsKey,
    value: JSON.stringify({
      running: true,
      brightness: currentBrightness,
      target: targetBrightness,
      step: stepValue,
      stepsRemaining: stepsRemaining,
      turnOffAtEnd: turnOffAtEnd
    })
  });
}

// Remove the persisted state once the fade has finished
function clearFadeState() {
  rpc("KVS.Delete", { key: CONFIG.kvsKey });
}

// Function executing a single brightness adjustment step
function executeFadeStep() {
  if (stepsRemaining <= 0) {
    // End of the dimming/brightening process
    Timer.clear(fadeTimer);
    fadeTimer = null;

    // Snap exactly to the target to remove rounding drift
    rpc("Light.Set", { id: CONFIG.id, on: true, brightness: targetBrightness });

    // If it is the evening sequence, turn off the device completely
    if (turnOffAtEnd) {
      rpc("Light.Set", { id: CONFIG.id, on: false });
    }

    clearFadeState();
    print("Fade finished at " + targetBrightness + "%");
    return;
  }

  currentBrightness += stepValue;
  stepsRemaining--;

  // Safeguard to keep brightness within the 0-100 range
  var setVal = Math.round(currentBrightness);
  if (setVal < 0) setVal = 0;
  if (setVal > 100) setVal = 100;

  rpc("Light.Set", { id: CONFIG.id, on: true, brightness: setVal });
  saveFadeState();
}

// Continues setting up the fade once the actual brightness is known
function startFadeWithBrightness(actualBrightness, durationMin, endBright, shouldOff) {
  // Always fade from the real current level to avoid brightness jumps
  currentBrightness = actualBrightness;
  targetBrightness = endBright;
  turnOffAtEnd = shouldOff;

  // Calculate the step value for each 1-minute interval
  var totalSteps = durationMin;
  stepValue = (targetBrightness - currentBrightness) / totalSteps;
  stepsRemaining = totalSteps;

  // Set the initial brightness value and turn on the device
  rpc("Light.Set", { id: CONFIG.id, on: true, brightness: Math.round(currentBrightness) });
  saveFadeState();

  // Start the timer to execute a step every 60 seconds (60000 ms)
  fadeTimer = Timer.set(60000, true, executeFadeStep);
}

// Function initializing the fading process: read the real light level first
function startFade(durationMin, endBright, shouldOff) {
  // If a previous fading process is running, stop it
  if (fadeTimer) {
    Timer.clear(fadeTimer);
    fadeTimer = null;
  }

  rpc("Light.GetStatus", { id: CONFIG.id }, function (result) {
    var actual = 0;
    if (result && typeof result.brightness === "number") {
      actual = result.brightness;
    }
    startFadeWithBrightness(actual, durationMin, endBright, shouldOff);
  });
}

// Resumes a fade that was interrupted by a reboot (state read from KVS)
function resumeFadeFromState(state) {
  currentBrightness = state.brightness;
  targetBrightness = state.target;
  stepValue = state.step;
  stepsRemaining = state.stepsRemaining;
  turnOffAtEnd = state.turnOffAtEnd;

  print("Resuming interrupted fade: " + Math.round(currentBrightness) + "% -> " + targetBrightness + "%, " + stepsRemaining + " min left");

  fadeTimer = Timer.set(60000, true, executeFadeStep);
}

// Checks KVS for an interrupted fade and resumes it if found
function checkInterruptedFade() {
  rpc("KVS.Get", { key: CONFIG.kvsKey }, function (result) {
    if (!result || !result.value) return;
    var state = JSON.parse(result.value);
    if (state && state.running && state.stepsRemaining > 0) {
      resumeFadeFromState(state);
    }
  });
}

// Function to install schedules into the Shelly system (if they don't exist yet)
function setupSchedules() {
  // RPC call to fetch existing schedules
  Shelly.call("Schedule.List", {}, function (result, errorCode, errorMessage) {
    if (errorCode !== 0) {
      print("Schedule.List failed: " + errorMessage);
      return;
    }

    var morningExists = false;
    var eveningExists = false;

    if (result && result.jobs) {
      for (var i = 0; i < result.jobs.length; i++) {
        if (result.jobs[i].comment === "FadeIn_1145") morningExists = true;
        if (result.jobs[i].comment === "FadeOut_2000") eveningExists = true;
      }
    }

    // Create the morning schedule (11:45)
    if (!morningExists) {
      Shelly.call("Schedule.Create", {
        enable: true,
        timespec: CONFIG.morning.cron,
        comment: "FadeIn_1145",
        calls: [{
          method: "Script.Eval",
          params: { id: Shelly.getCurrentScriptId(), code: "startFade(CONFIG.morning.durationMin, CONFIG.morning.endBrightness, false);" }
        }]
      });
    }

    // Create the evening schedule (20:00)
    if (!eveningExists) {
      Shelly.call("Schedule.Create", {
        enable: true,
        timespec: CONFIG.evening.cron,
        comment: "FadeOut_2000",
        calls: [{
          method: "Script.Eval",
          params: { id: Shelly.getCurrentScriptId(), code: "startFade(CONFIG.evening.durationMin, CONFIG.evening.endBrightness, true);" }
        }]
      });
    }
  });
}

// Initialize schedules when the device boots up
setupSchedules();

// Resume a fade if the device was rebooted mid-fade
checkInterruptedFade();

print("0-10V Dimmer schedule script has been successfully initialized.");
