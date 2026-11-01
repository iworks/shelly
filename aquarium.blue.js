// Aquarium moonlight (actinic blue) script.
// Turns the blue channel on in the evening after the main light goes off
// (fade-in 20:00-20:15) and off late at night (fade-out 21:45-22:00).

// Script configuration
var CONFIG = {
  id: 0, // Light component ID on this 0-10V dimmer device (always 0)
  kvsKey: "aquarium_blue_fade_state",

  // Evening moonlight on: 20:00 -> 20:15, up to 40%
  moonIn: {
    cron: "0 0 20 * * *", // 08:00 PM every day
    comment: "MoonIn_2000",
    durationMin: 15,
    endBrightness: 40,
    turnOffAtEnd: false
  },

  // Late night moonlight off: 21:45 -> 22:00, down to 0% and turn off
  moonOut: {
    cron: "0 45 21 * * *", // 09:45 PM every day
    comment: "MoonOut_2145",
    durationMin: 15,
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

    // If it is the night sequence, turn off the device completely
    if (turnOffAtEnd) {
      rpc("Light.Set", { id: CONFIG.id, on: false });
    }

    clearFadeState();
    print("Moonlight fade finished at " + targetBrightness + "%");
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

  print("Resuming interrupted moonlight fade: " + Math.round(currentBrightness) + "% -> " + targetBrightness + "%, " + stepsRemaining + " min left");

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

    var moonInExists = false;
    var moonOutExists = false;

    if (result && result.jobs) {
      for (var i = 0; i < result.jobs.length; i++) {
        if (result.jobs[i].comment === CONFIG.moonIn.comment) moonInExists = true;
        if (result.jobs[i].comment === CONFIG.moonOut.comment) moonOutExists = true;
      }
    }

    // Create the moonlight-on schedule (20:00)
    if (!moonInExists) {
      Shelly.call("Schedule.Create", {
        enable: true,
        timespec: CONFIG.moonIn.cron,
        comment: CONFIG.moonIn.comment,
        calls: [{
          method: "Script.Eval",
          params: { id: Shelly.getCurrentScriptId(), code: "startFade(CONFIG.moonIn);" }
        }]
      });
    }

    // Create the moonlight-off schedule (21:45)
    if (!moonOutExists) {
      Shelly.call("Schedule.Create", {
        enable: true,
        timespec: CONFIG.moonOut.cron,
        comment: CONFIG.moonOut.comment,
        calls: [{
          method: "Script.Eval",
          params: { id: Shelly.getCurrentScriptId(), code: "startFade(CONFIG.moonOut);" }
        }]
      });
    }
  });
}

// Initialize schedules when the device boots up
setupSchedules();

// Resume a fade if the device was rebooted mid-fade
checkInterruptedFade();

print("Moonlight (blue) schedule script has been successfully initialized.");
