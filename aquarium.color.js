// Aquarium RGB sunrise/sunset script.
// Runs BEFORE the white light in the morning (11:15-11:45) and AFTER it
// in the evening (20:00-20:30), ramping through colors like a real sunset.

// Script configuration
var CONFIG = {
  id: 0, // RGB Light component ID
  kvsKey: "aquarium_color_fade_state",

  // Morning sunrise: 11:15 -> 11:45, deep orange-red to warm white, then off
  // (the white light script takes over at 11:45)
  morning: {
    cron: "0 15 11 * * *", // 11:15 AM every day
    comment: "ColorSunrise_1115",
    durationMin: 30,
    startColor: { r: 255, g: 60, b: 0 },
    endColor: { r: 255, g: 190, b: 120 },
    turnOffAtEnd: true
  },

  // Evening sunset: 20:00 -> 20:30, warm white to deep red, then off
  // (the white light script turns off at 20:00)
  evening: {
    cron: "0 0 20 * * *", // 08:00 PM every day
    comment: "ColorSunset_2000",
    durationMin: 30,
    startColor: { r: 255, g: 190, b: 120 },
    endColor: { r: 255, g: 40, b: 0 },
    turnOffAtEnd: true
  }
};

// Helper variables for the fading process timer
var fadeTimer = null;
var currentColor = null;
var targetColor = null;
var stepsRemaining = 0;
var startColorCopy = null;
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
      current: currentColor,
      target: targetColor,
      start: startColorCopy,
      stepsRemaining: stepsRemaining,
      turnOffAtEnd: turnOffAtEnd
    })
  });
}

// Remove the persisted state once the fade has finished
function clearFadeState() {
  rpc("KVS.Delete", { key: CONFIG.kvsKey });
}

// Apply a color to the light (clamped to 0-255)
function applyColor(c) {
  var r = Math.round(c.r); if (r < 0) r = 0; if (r > 255) r = 255;
  var g = Math.round(c.g); if (g < 0) g = 0; if (g > 255) g = 255;
  var b = Math.round(c.b); if (b < 0) b = 0; if (b > 255) b = 255;
  rpc("Light.Set", { id: CONFIG.id, on: true, rgb: [r, g, b] });
}

// Function executing a single color ramp step
function executeFadeStep() {
  if (stepsRemaining <= 0) {
    // End of the ramp: snap exactly to the target color
    Timer.clear(fadeTimer);
    fadeTimer = null;

    applyColor(targetColor);

    if (turnOffAtEnd) {
      rpc("Light.Set", { id: CONFIG.id, on: false });
    }

    clearFadeState();
    print("Color ramp finished");
    return;
  }

  stepsRemaining--;

  // Interpolate each channel from the start color toward the target color
  var ratio = 1 - stepsRemaining / totalStepsCount;
  currentColor = {
    r: startColorCopy.r + (targetColor.r - startColorCopy.r) * ratio,
    g: startColorCopy.g + (targetColor.g - startColorCopy.g) * ratio,
    b: startColorCopy.b + (targetColor.b - startColorCopy.b) * ratio
  };

  applyColor(currentColor);
  saveFadeState();
}

// Total step counter (used for interpolation ratio)
var totalStepsCount = 0;

// Function initializing the color ramp process
function startColorRamp(phase) {
  // If a previous fading process is running, stop it
  if (fadeTimer) {
    Timer.clear(fadeTimer);
    fadeTimer = null;
  }

  startColorCopy = { r: phase.startColor.r, g: phase.startColor.g, b: phase.startColor.b };
  targetColor = { r: phase.endColor.r, g: phase.endColor.g, b: phase.endColor.b };
  turnOffAtEnd = phase.turnOffAtEnd;
  totalStepsCount = phase.durationMin;
  stepsRemaining = phase.durationMin;

  // Set the initial color and turn on the device
  currentColor = startColorCopy;
  applyColor(currentColor);
  saveFadeState();

  // Start the timer to execute a step every 60 seconds (60000 ms)
  fadeTimer = Timer.set(60000, true, executeFadeStep);
}

// Resumes a ramp that was interrupted by a reboot (state read from KVS)
function resumeRampFromState(state) {
  startColorCopy = state.start;
  targetColor = state.target;
  currentColor = state.current;
  turnOffAtEnd = state.turnOffAtEnd;
  totalStepsCount = state.stepsRemaining; // approximation: ratio continues smoothly
  stepsRemaining = state.stepsRemaining;

  print("Resuming interrupted color ramp, " + stepsRemaining + " min left");

  fadeTimer = Timer.set(60000, true, executeFadeStep);
}

// Checks KVS for an interrupted ramp and resumes it if found
function checkInterruptedRamp() {
  rpc("KVS.Get", { key: CONFIG.kvsKey }, function (result) {
    if (!result || !result.value) return;
    var state = JSON.parse(result.value);
    if (state && state.running && state.stepsRemaining > 0) {
      resumeRampFromState(state);
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
          params: { id: Shelly.getCurrentScriptId(), code: "startColorRamp(CONFIG.morning);" }
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
          params: { id: Shelly.getCurrentScriptId(), code: "startColorRamp(CONFIG.evening);" }
        }]
      });
    }
  });
}

// Initialize schedules when the device boots up
setupSchedules();

// Resume a ramp if the device was rebooted mid-fade
checkInterruptedRamp();

print("RGB sunrise/sunset script has been successfully initialized.");
