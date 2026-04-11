// ============================================================================
// TempMail AutoFill - Popup Script
// ============================================================================

document.addEventListener("DOMContentLoaded", async () => {
  // Elements
  const emailStatus = document.getElementById("email-status");
  const emailDisplay = document.getElementById("email-display");
  const emailAddress = document.getElementById("email-address");
  const emailPassword = document.getElementById("email-password");
  const copyEmailBtn = document.getElementById("copy-email");
  const copyPasswordBtn = document.getElementById("copy-password");
  const togglePasswordBtn = document.getElementById("toggle-password");
  const createEmailBtn = document.getElementById("create-email");
  const refreshInboxBtn = document.getElementById("refresh-inbox");
  const inboxList = document.getElementById("inbox-list");
  const inboxCount = document.getElementById("inbox-count");
  const otpSection = document.getElementById("otp-section");
  const otpCode = document.getElementById("otp-code");
  const otpFrom = document.getElementById("otp-from");
  const copyOtpBtn = document.getElementById("copy-otp");
  const settingsBtn = document.getElementById("settings-btn");
  const versionEl = document.getElementById("version");

  // Modal elements
  const messageModal = document.getElementById("message-modal");
  const modalSubject = document.getElementById("modal-subject");
  const modalFrom = document.getElementById("modal-from");
  const modalDate = document.getElementById("modal-date");
  const modalBody = document.getElementById("modal-body");
  const modalClose = document.getElementById("modal-close");

  let currentEmailData = null;
  let passwordVisible = false;

  // ============================================================================
  // Load manifest version
  // ============================================================================
  const manifest = chrome.runtime.getManifest();
  versionEl.textContent = `v${manifest.version}`;

  // ============================================================================
  // Initialize
  // ============================================================================
  async function init() {
    const response = await chrome.runtime.sendMessage({ action: "getEmail" });
    if (response && response.email) {
      currentEmailData = response;
      updateUI(response);
    } else {
      showNoEmailState();
    }

    // Check for OTP
    const otp = await chrome.runtime.sendMessage({ action: "getOTP" });
    if (otp) {
      showOTP(otp);
    }
  }

  // ============================================================================
  // UI Updates
  // ============================================================================
  function updateUI(data) {
    emailStatus.classList.add("hidden");
    emailDisplay.classList.remove("hidden");

    emailAddress.value = data.email;
    emailPassword.value = data.password || "Click 'New Email' to generate";

    // Update inbox
    const messages = data.messages || [];
    inboxCount.textContent = `${messages.length} message${messages.length !== 1 ? "s" : ""}`;

    if (messages.length > 0) {
      inboxList.innerHTML = "";
      messages.forEach((msg, index) => {
        const item = document.createElement("div");
        item.className = `inbox-item${index === 0 ? " unread" : ""}`;
        item.innerHTML = `
          <div class="inbox-item-from">${escapeHtml(msg.from || msg.from_email || "Unknown")}</div>
          <div class="inbox-item-subject">${escapeHtml(msg.subject || "No subject")}</div>
          <div class="inbox-item-date">${formatDate(msg.date || msg.timestamp)}</div>
        `;
        item.addEventListener("click", () => openMessage(msg));
        inboxList.appendChild(item);
      });
    } else {
      inboxList.innerHTML = `
        <div class="inbox-empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <path d="M22 4L12 13L2 4"/>
          </svg>
          <p>No messages yet</p>
        </div>
      `;
    }

    // Update status
    emailStatus.classList.remove("hidden");
    if (data.isDead) {
      emailStatus.classList.add("dead");
      emailStatus.innerHTML = `
        <div class="status-dot dead"></div>
        <span>Expired: ${data.email}</span>
      `;
    } else {
      emailStatus.classList.remove("dead");
      emailStatus.innerHTML = `
        <div class="status-dot active"></div>
        <span>Active: ${data.email}</span>
      `;
    }
  }

  function showNoEmailState() {
    emailDisplay.classList.add("hidden");
    emailStatus.classList.remove("hidden");
    emailStatus.innerHTML = `
      <div class="status-dot inactive"></div>
      <span>No active email</span>
    `;
    inboxCount.textContent = "0 messages";
    inboxList.innerHTML = `
      <div class="inbox-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="4" width="20" height="16" rx="2"/>
          <path d="M22 4L12 13L2 4"/>
        </svg>
        <p>Create a temporary email to get started</p>
      </div>
    `;
    otpSection.classList.add("hidden");
  }

  function showOTP(otp) {
    otpSection.classList.remove("hidden");
    otpCode.textContent = otp.code;
    otpFrom.textContent = otp.from || "";
  }

  // ============================================================================
  // Event Handlers
  // ============================================================================

  // Create new email (handles all types)
  const emailTypeSelect = document.getElementById("email-type");

  createEmailBtn.addEventListener("click", async () => {
    createEmailBtn.disabled = true;
    createEmailBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin">
        <path d="M21 12a9 9 0 11-6.219-8.56"/>
      </svg>
      Creating...
    `;

    const type = emailTypeSelect ? emailTypeSelect.value : "other";
    let action = "createEmail";
    if (type === "google") action = "createGmail";
    if (type === "microsoft") action = "createOutlook";

    const result = await chrome.runtime.sendMessage({ action });
    if (result) {
      currentEmailData = result;
      updateUI(result);
    }

    createEmailBtn.disabled = false;
    createEmailBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      New Email
    `;
  });

  // Refresh inbox
  refreshInboxBtn.addEventListener("click", async () => {
    refreshInboxBtn.disabled = true;
    refreshInboxBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin">
        <path d="M21 12a9 9 0 11-6.219-8.56"/>
      </svg>
      Checking...
    `;

    const messages = await chrome.runtime.sendMessage({ action: "checkInbox" });
    if (messages && currentEmailData) {
      currentEmailData.messages = messages;
      updateUI(currentEmailData);
    }

    refreshInboxBtn.disabled = false;
    refreshInboxBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="23 4 23 10 17 10"/>
        <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
      </svg>
      Refresh Inbox
    `;
  });

  // Copy email
  copyEmailBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(emailAddress.value).then(() => {
      copyEmailBtn.classList.add("copied");
      setTimeout(() => copyEmailBtn.classList.remove("copied"), 1500);
    });
  });

  // Copy password
  copyPasswordBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(emailPassword.value).then(() => {
      copyPasswordBtn.classList.add("copied");
      setTimeout(() => copyPasswordBtn.classList.remove("copied"), 1500);
    });
  });

  // Toggle password visibility
  togglePasswordBtn.addEventListener("click", () => {
    passwordVisible = !passwordVisible;
    emailPassword.type = passwordVisible ? "text" : "password";
  });

  // Copy OTP
  copyOtpBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(otpCode.textContent).then(() => {
      copyOtpBtn.classList.add("copied");
      setTimeout(() => copyOtpBtn.classList.remove("copied"), 1500);
    });
  });

  // Settings
  settingsBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // Modal close
  modalClose.addEventListener("click", () => {
    messageModal.classList.add("hidden");
  });

  messageModal.addEventListener("click", (e) => {
    if (e.target === messageModal) {
      messageModal.classList.add("hidden");
    }
  });

  // ============================================================================
  // Message Handling
  // ============================================================================
  async function openMessage(msg) {
    modalSubject.textContent = msg.subject || "No subject";
    modalFrom.textContent = msg.from || msg.from_email || "Unknown";
    modalDate.textContent = formatDate(msg.date || msg.timestamp);

    // Fetch full message if needed
    if (!msg.body) {
      const fullMsg = await chrome.runtime.sendMessage({
        action: "readMessage",
        mid: msg.mid,
      });
      if (fullMsg) {
        msg = fullMsg;
      }
    }

    // Display body with all links opening in new tabs
    const body = msg.body || msg.body_html || "No content";
    // Add target="_blank" to all links
    const bodyWithTarget = body.replace(/<a\s/gi, '<a target="_blank" rel="noopener" ');
    modalBody.innerHTML = bodyWithTarget;

    // Intercept all link clicks to open in new tab
    modalBody.addEventListener("click", (e) => {
      const link = e.target.closest("a");
      if (link && link.href) {
        e.preventDefault();
        e.stopPropagation();
        chrome.tabs.create({ url: link.href });
      }
    });

    messageModal.classList.remove("hidden");
  }

  // ============================================================================
  // Listen for messages from background
  // ============================================================================
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "newMessages") {
      if (currentEmailData) {
        currentEmailData.messages = message.messages;
        updateUI(currentEmailData);
      }
    }

    if (message.action === "otpDetected") {
      showOTP(message);
    }

    if (message.action === "emailCreated") {
      currentEmailData = {
        email: message.email,
        password: message.password,
        messages: [],
        isDead: false,
      };
      updateUI(currentEmailData);
    }

    if (message.action === "emailDead") {
      if (currentEmailData) {
        currentEmailData.isDead = true;
        updateUI(currentEmailData);
      }
    }
  });

  // ============================================================================
  // Helpers
  // ============================================================================
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function formatDate(dateStr) {
    if (!dateStr) return "";
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diff = now - date;

      if (diff < 60000) return "Just now";
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
      return date.toLocaleDateString();
    } catch {
      return dateStr;
    }
  }

  // ============================================================================
  // Start
  // ============================================================================
  init();
});
