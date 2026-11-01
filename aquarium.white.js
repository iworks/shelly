// Script configuration
var CONFIG = {
  id: 0, // Light component ID in Shelly Plus (usually 0)
  
  // Morning: from 11:45 for 15 minutes up to 70%
  morning: {
    cron: "0 45 11 * * *", // 11:45 AM every day
    durationMin: 15,       // duration in minutes
    startBrightness: 0,
    endBrightness: 70
  },
  
  // Evening: from 20:00 for 15 minutes down to 0% and turn off
  evening: {
    cron: "0 0 20 * * *",  // 08:00 PM every day
    durationMin: 15,       // duration in minutes
    startBrightness: 70,
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

// Function executing a single brightness adjustment step
function executeFadeStep() {
  if (stepsRemaining <= 0) {
    // End of the dimming/brightening process
    Timer.clear(fadeTimer);
    fadeTimer = null;
    
    // If it is the evening sequence, turn off the device completely
    if (turnOffAtEnd) {
      Shelly.call("Light.Set", { id: CONFIG.id, on: false });
    }
    return;
  }
  
  currentBrightness += stepValue;
  stepsRemaining--;
  
  // Safeguard to keep brightness within the 0-100 range
  var setVal = Math.round(currentBrightness);
  if (setVal < 0) setVal = 0;
  if (setVal > 100) setVal = 100;
  
  Shelly.call("Light.Set", { id: CONFIG.id, on: true, brightness: setVal });
}

// Function initializing the fading process
function startFade(durationMin, startBright, endBright, shouldOff) {
  // If a previous fading process is running, stop it
  if (fadeTimer) {
    Timer.clear(fadeTimer);
  }
  
  currentBrightness = startBright;
  targetBrightness = endBright;
  turnOffAtEnd = shouldOff;
  
  // Calculate the step value for each 1-minute interval
  var totalSteps = durationMin; 
  stepValue = (targetBrightness - currentBrightness) / totalSteps;
  stepsRemaining = totalSteps;
  
  // Set the initial brightness value and turn on the device
  Shelly.call("Light.Set", { id: CONFIG.id, on: true, brightness: Math.round(currentBrightness) });
  
  // Start the timer to execute a step every 60 seconds (60000 ms)
  fadeTimer = Timer.set(60000, true, executeFadeStep);
}

// Function to install schedules into the Shelly system (if they don't exist yet)
function setupSchedules() {
  // RPC call to fetch existing schedules
  Shelly.call("Schedule.List", {}, function (result) {
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
          params: { id: Shelly.getCurrentScriptId(), code: "startFade(CONFIG.morning.durationMin, CONFIG.morning.startBrightness, CONFIG.morning.endBrightness, false);" }
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
          params: { id: Shelly.getCurrentScriptId(), code: "startFade(CONFIG.evening.durationMin, CONFIG.evening.startBrightness, CONFIG.evening.endBrightness, true);" }
        }]
      });
    }
  });
}

// Initialize schedules when the device boots up
setupSchedules();
print("0-10V Dimmer schedule script has been successfully initialized.");

