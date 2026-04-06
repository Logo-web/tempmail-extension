// ============================================================================
// TempMail AutoFill - Options Page Script
// ============================================================================

document.addEventListener("DOMContentLoaded", async () => {
  // Elements
  const autoFillEnabled = document.getElementById("auto-fill-enabled");
  const autoGeneratePassword = document.getElementById("auto-generate-password");
  const passwordLength = document.getElementById("password-length");
  const autoCheckInbox = document.getElementById("auto-check-inbox");
  const pollInterval = document.getElementById("poll-interval");
  const showNotification = document.getElementById("show-notification");
  const otpAutoFill = document.getElementById("otp-auto-fill");
  const otpAutoSubmit = document.getElementById("otp-auto-submit");
  const saveBtn = document.getElementById("save-settings");
  const saveStatus = document.getElementById("save-status");

  // Load saved settings
  const settings = await chrome.storage.local.get([
    "autoFillEnabled",
    "autoGeneratePassword",
    "passwordLength",
    "autoCheckInbox",
    "inboxPollInterval",
    "showNotification",
    "otpAutoFill",
    "otpAutoSubmit",
  ]);

  autoFillEnabled.checked = settings.autoFillEnabled !== false;
  autoGeneratePassword.checked = settings.autoGeneratePassword !== false;
  passwordLength.value = settings.passwordLength || 16;
  autoCheckInbox.checked = settings.autoCheckInbox !== false;
  pollInterval.value = settings.inboxPollInterval
    ? settings.inboxPollInterval / 1000
    : 5;
  showNotification.checked = settings.showNotification !== false;
  otpAutoFill.checked = settings.otpAutoFill !== false;
  otpAutoSubmit.checked = settings.otpAutoSubmit === true;

  // Save settings
  saveBtn.addEventListener("click", async () => {
    const newSettings = {
      autoFillEnabled: autoFillEnabled.checked,
      autoGeneratePassword: autoGeneratePassword.checked,
      passwordLength: parseInt(passwordLength.value) || 16,
      autoCheckInbox: autoCheckInbox.checked,
      inboxPollInterval: (parseInt(pollInterval.value) || 5) * 1000,
      showNotification: showNotification.checked,
      otpAutoFill: otpAutoFill.checked,
      otpAutoSubmit: otpAutoSubmit.checked,
    };

    await chrome.storage.local.set(newSettings);

    saveStatus.textContent = "Settings saved!";
    setTimeout(() => {
      saveStatus.textContent = "";
    }, 2000);
  });
});
