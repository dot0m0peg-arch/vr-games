"use strict";
const checkButton = document.querySelector("#check-xr");
const statusMessage = document.querySelector("#xr-status");
checkButton.addEventListener("click", async () => {
  checkButton.disabled = true;
  statusMessage.textContent = "Checking immersive VR support…";
  try {
    if (!window.isSecureContext) {
      statusMessage.textContent = "VR requires a secure connection. Open the HTTPS version of this site.";
    } else if (!navigator.xr) {
      statusMessage.textContent = "Immersive VR is not available in this browser. Try opening this site in a WebXR-compatible headset browser.";
    } else {
      const supported = await navigator.xr.isSessionSupported("immersive-vr");
      statusMessage.textContent = supported
        ? "Immersive VR is available. Open a game and use its Enter VR button."
        : "This browser cannot currently start immersive VR. Check your headset connection or try your headset's browser.";
    }
  } catch {
    statusMessage.textContent = "The browser could not check VR support. Check your headset connection and browser settings, then try again.";
  } finally {
    checkButton.disabled = false;
  }
});
