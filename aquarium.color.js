// Aquarium accent light (sunrise/sunset) script for a 0-10V dimmer.
// NOTE: a 0-10V dimmer has a single brightness channel, so the "color"
// transitions are simulated by intensity: brightens during the sunrise
// window (11:15-11:45, before the white light takes over) and dims during
// the sunset window (20:00-20:30, after the white light turns off).

// Script configuration
var CONFIG = {
  id: 0, // Light component ID on this 0-10V dimmer device (always 0)
  kvsKey: "aquarium_color_fade_state",

  // Morning sunrise: 11:15 -> 11:45, ramp up to 100%, then off
  // (the white light script on the other device takes over at 11:45)
  morning: {
    cron: "0 15 11 * * *", // 11:15 AM every day
    comment: "ColorSunrise_1115",
    durationMin: 30,
    endBrightness: 100,
    turnOffAtEnd: true
  },

  // Evening sunset: 20:00 -> 20:30, start at 100% and ramp down to 0%, off
  // (the white light script on the other device turns off at 20:00)
  evening: {
    cron: "0 0 20 * * *", // 08:00 PM every day
    comment: "ColorSunset_2000",
    durationMin: 30,
    endBrightness: 0,
    turnOffAtEnd: true
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

    // Turn off the device completely at the end of the sequence
    if (turnOffAtEnd) {
      rpc("Light.Set", { id: CONFIG.id, on: false });
    }

    clearFadeState();
    print("Accent light fade finished at " + targetBrightness + "%");
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
function startFadeWithBrightness(actualBrightness, phase) {
  // Always fade from the real current level to avoid brightness jumps
  currentBrightness = actualBrightness;
  targetBrightness = phase.endBrightness;
  turnOffAtEnd = phase.turnOffAtEnd;

  // Calculate the step value for each 1-minute interval
  var totalSteps = phase.durationMin;
  stepValue = (targetBrightness - currentBrightness) / totalSteps;
  stepsRemaining = totalSteps;

  // Set the initial brightness value and turn on the device
  rpc("Light.Set", { id: CONFIG.id, on: true, brightness: Math.round(currentBrightness) });
  saveFadeState();

  // Start the timer to execute a step every 60 seconds (60000 ms)
  fadeTimer = Timer.set(60000, true, executeFadeStep);
}

// Function initializing the fading process: read the real light level first
function startFade(phase) {
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
    startFadeWithBrightness(actual, phase);
  });
}

// Resumes a fade that was interrupted by a reboot (state read from KVS)
function resumeFadeFromState(state) {
  currentBrightness = state.brightness;
  targetBrightness = state.target;
  stepValue = state.step;
  stepsRemaining = state.stepsRemaining;
  turnOffAtEnd = state.turnOffAtEnd;

  print("Resuming interrupted accent light fade: " + Math.round(currentBrightness) + "% -> " + targetBrightness + "%, " + stepsRemaining + " min left");

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
        if (result.jobs[i].comment === CONFIG.morning.comment) morningExists = true;
        if (result.jobs[i].comment === CONFIG.evening.comment) eveningExists = true;
      }
    }

    // Create the sunrise schedule (11:15)
    if (!morningExists) {
      Shelly.call("Schedule.Create", {
        enable: true,
        timespec: CONFIG.morning.cron,
        comment: CONFIG.morning.comment,
        calls: [{
          method: "Script.Eval",
          params: { id: Shelly.getCurrentScriptId(), code: "startFade(CONFIG.morning);" }
        }]
      });
    }

    // Create the sunset schedule (20:00)
    if (!eveningExists) {
      Shelly.call("Schedule.Create", {
        enable: true,
        timespec: CONFIG.evening.cron,
        comment: CONFIG.evening.comment,
        calls: [{
          method: "Script.Eval",
          params: { id: Shelly.getCurrentScriptId(), code: "startFade(CONFIG.evening);" }
        }]
      });
    }
  });
}

// Initialize schedules when the device boots up
setupSchedules();

// Resume a fade if the device was rebooted mid-fade
checkInterruptedFade();

print("Accent light (sunrise/sunset) schedule script has been successfully initialized.");
