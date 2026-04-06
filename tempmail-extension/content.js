// ============================================================================
// TempMail AutoFill - Content Script
// ============================================================================

(function () {
  "use strict";

  const DATALIST_ID = "tempmail-autocomplete-list";

  let emailData = null;
  let otpDetected = null;
  let verificationLinks = null;
  let verificationLinksFrom = "";
  let verificationLinksSubject = "";
  let settings = {};
  let hasInjectedDatalist = false;
  let observedForms = new Set();

  // ============================================================================
  // Registration Form Detection
  // ============================================================================

  const EMAIL_FIELD_SELECTORS = [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[name*="mail" i]',
    'input[id*="email" i]',
    'input[id*="mail" i]',
    'input[placeholder*="email" i]',
    'input[placeholder*="mail" i]',
    'input[autocomplete="email"]',
  ];

  const PASSWORD_FIELD_SELECTORS = [
    'input[type="password"]',
    'input[name*="password" i]',
    'input[name*="passwd" i]',
    'input[name*="pass" i]',
    'input[id*="password" i]',
    'input[id*="passwd" i]',
    'input[id*="pass" i]',
    'input[placeholder*="password" i]',
    'input[placeholder*="passwd" i]',
    'input[placeholder*="pass" i]',
  ];

  const OTP_FIELD_SELECTORS = [
    'input[type="tel"][maxlength="6"]',
    'input[type="text"][maxlength="6"]',
    'input[type="text"][maxlength="8"]',
    'input[name*="otp" i]',
    'input[name*="code" i]',
    'input[name*="verify" i]',
    'input[name*="confirm" i]',
    'input[id*="otp" i]',
    'input[id*="code" i]',
    'input[id*="verify" i]',
    'input[id*="confirm" i]',
    'input[placeholder*="code" i]',
    'input[placeholder*="OTP" i]',
    'input[placeholder*="verification" i]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"][maxlength="6"]',
    'input[inputmode="numeric"][maxlength="8"]',
    'input[data-inputmode="numeric"]',
    '.otp-input',
    '.verification-code',
    '.confirm-code',
  ];

  const FORM_INDICATORS = [
    "signup",
    "sign-up",
    "sign_up",
    "register",
    "registration",
    "create.*account",
    "new.*account",
    "join",
    "subscribe",
  ];

  const PAGE_INDICATORS = [
    "sign up",
    "signup",
    "sign-up",
    "register",
    "registration",
    "create account",
    "get started",
    "join now",
    "start free",
    "try free",
    "begin",
    "welcome",
    "magic link",
    "continue with email",
    "enter your email",
  ];

  function isRegistrationForm(form) {
    const text = (
      form.innerHTML +
      form.textContent +
      document.title +
      document.body.textContent
    ).toLowerCase();

    return FORM_INDICATORS.some((pattern) =>
      new RegExp(pattern, "i").test(text)
    );
  }

  function isRegistrationPage() {
    const text = (
      document.title +
      document.body.textContent
    ).toLowerCase();

    return PAGE_INDICATORS.some((pattern) =>
      new RegExp(pattern, "i").test(text)
    );
  }

  // ============================================================================
  // Datalist-based Autocomplete (native browser dropdown)
  // ============================================================================

  function ensureDatalist() {
    let datalist = document.getElementById(DATALIST_ID);
    if (!datalist) {
      datalist = document.createElement("datalist");
      datalist.id = DATALIST_ID;
      document.body.appendChild(datalist);
      hasInjectedDatalist = true;
    }
    return datalist;
  }

  function updateDatalist() {
    if (!emailData || !emailData.email) return;

    const datalist = ensureDatalist();

    // Clear existing options
    datalist.innerHTML = "";

    // Add temp email option
    const option = document.createElement("option");
    option.value = emailData.email;
    option.textContent = `${emailData.email} (TempMail)`;
    datalist.appendChild(option);

    // Add password as a second option (some browsers show it)
    if (emailData.password) {
      const pwOption = document.createElement("option");
      pwOption.value = emailData.password;
      pwOption.textContent = "Generated Password";
      datalist.appendChild(pwOption);
    }

    // Attach datalist to all email fields
    attachDatalistToEmailFields();
  }

  function attachDatalistToEmailFields() {
    const datalist = document.getElementById(DATALIST_ID);
    if (!datalist) return;

    const emailFields = findAllEmailFields();
    emailFields.forEach((field) => {
      if (field.getAttribute("list") !== DATALIST_ID) {
        field.setAttribute("list", DATALIST_ID);
        field.setAttribute("autocomplete", "email");

        // Add a subtle visual indicator
        if (!field.dataset.tempmailAttached) {
          field.dataset.tempmailAttached = "true";
          addTempmailIndicator(field);
        }
      }
    });
  }

  function findAllEmailFields() {
    const fields = [];
    for (const selector of EMAIL_FIELD_SELECTORS) {
      document.querySelectorAll(selector).forEach((field) => {
        if (
          field.type !== "hidden" &&
          field.offsetParent !== null &&
          !field.disabled &&
          !field.readOnly &&
          !fields.includes(field)
        ) {
          fields.push(field);
        }
      });
    }
    return fields;
  }

  function addTempmailIndicator(field) {
    // Add a small icon/badge next to the field showing temp email is available
    const wrapper = document.createElement("div");
    wrapper.className = "tempmail-field-wrapper";
    wrapper.style.position = "relative";
    wrapper.style.display = "inline-block";
    wrapper.style.width = "100%";

    // Wrap the field
    field.parentNode.insertBefore(wrapper, field);
    wrapper.appendChild(field);

    // Add indicator badge
    const badge = document.createElement("div");
    badge.className = "tempmail-field-badge";
    badge.innerHTML = `
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <rect x="2" y="4" width="20" height="16" rx="2"/>
        <path d="M22 4L12 13L2 4"/>
      </svg>
    `;
    badge.title = "TempMail AutoFill available – click the field to see suggestions";
    wrapper.appendChild(badge);

    // Click on badge fills the field
    badge.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (emailData) {
        field.value = emailData.email;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        field.focus();
        badge.style.display = "none";
      }
    });
  }

  // ============================================================================
  // Find helpers
  // ============================================================================

  function findEmailField(form) {
    for (const selector of EMAIL_FIELD_SELECTORS) {
      const field = form.querySelector(selector);
      if (field && field.type !== "hidden") return field;
    }
    return null;
  }

  function findPasswordField(form) {
    for (const selector of PASSWORD_FIELD_SELECTORS) {
      const field = form.querySelector(selector);
      if (field && field.type !== "hidden") return field;
    }
    return null;
  }

  function findOTPField() {
    for (const selector of OTP_FIELD_SELECTORS) {
      const fields = document.querySelectorAll(selector);
      for (const field of fields) {
        if (
          field.type !== "hidden" &&
          field.offsetParent !== null &&
          !field.disabled &&
          !field.readOnly
        ) {
          return field;
        }
      }
    }
    return null;
  }

  function extractVerificationLinks(text) {
    if (!text) return [];
    const hrefUrls = text.match(/href=["'](https?:\/\/[^"']+)["']/gi) || [];
    const extracted = hrefUrls.map((match) => {
      const urlMatch = match.match(/href=["'](https?:\/\/[^"']+)["']/i);
      return urlMatch ? urlMatch[1] : null;
    }).filter(Boolean);
    const plainUrls = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
    const allUrls = [...new Set([...extracted, ...plainUrls])];
    return allUrls.filter((url) => {
      const lower = url.toLowerCase();
      return (
        lower.includes("verify") ||
        lower.includes("confirm") ||
        lower.includes("token") ||
        lower.includes("auth") ||
        lower.includes("callback") ||
        lower.includes("magic") ||
        lower.includes("login") ||
        lower.includes("activate") ||
        lower.includes("signup") ||
        lower.includes("register") ||
        lower.includes("set-password") ||
        lower.includes("reset-password") ||
        lower.includes("verification") ||
        lower.includes("email-verify")
      );
    });
  }

  // ============================================================================
  // UI Components
  // ============================================================================

  function createPromptWidget(email, password, emailField, passwordField) {
    const existing = document.getElementById("tempmail-widget");
    if (existing) existing.remove();

    const widget = document.createElement("div");
    widget.id = "tempmail-widget";
    widget.className = "tempmail-widget";
    widget.innerHTML = `
      <div class="tempmail-widget-header">
        <div class="tempmail-widget-logo">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <path d="M22 4L12 13L2 4"/>
          </svg>
        </div>
        <span class="tempmail-widget-title">Use temporary email?</span>
        <button class="tempmail-widget-close" title="Close">&times;</button>
      </div>
      <div class="tempmail-widget-body">
        <div class="tempmail-email-display">
          <code class="tempmail-email-text">${email}</code>
          <button class="tempmail-copy-btn" data-copy="${email}" title="Copy email">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>
          </button>
        </div>
        <div class="tempmail-password-display">
          <span class="tempmail-label">Generated Password:</span>
          <code class="tempmail-password-text">${password}</code>
          <button class="tempmail-copy-btn" data-copy="${password}" title="Copy password">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="tempmail-widget-actions">
        <button class="tempmail-btn tempmail-btn-fill">Auto-fill form</button>
        <button class="tempmail-btn tempmail-btn-dismiss">Maybe later</button>
      </div>
    `;

    document.body.appendChild(widget);

    widget.querySelector(".tempmail-widget-close").addEventListener("click", () => {
      widget.remove();
    });

    widget.querySelector(".tempmail-btn-fill").addEventListener("click", () => {
      if (emailField) {
        emailField.value = email;
        emailField.dispatchEvent(new Event("input", { bubbles: true }));
        emailField.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (passwordField) {
        passwordField.value = password;
        passwordField.dispatchEvent(new Event("input", { bubbles: true }));
        passwordField.dispatchEvent(new Event("change", { bubbles: true }));
      }
      widget.remove();
    });

    widget.querySelector(".tempmail-btn-dismiss").addEventListener("click", () => {
      widget.remove();
    });

    widget.querySelectorAll(".tempmail-copy-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const text = btn.getAttribute("data-copy");
        navigator.clipboard.writeText(text).then(() => {
          const originalHTML = btn.innerHTML;
          btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>`;
          setTimeout(() => {
            btn.innerHTML = originalHTML;
          }, 1500);
        });
      });
    });

    return widget;
  }

  function createOTPWidget(code, from, subject) {
    const existing = document.getElementById("tempmail-otp-widget");
    if (existing) existing.remove();

    const widget = document.createElement("div");
    widget.id = "tempmail-otp-widget";
    widget.className = "tempmail-widget tempmail-otp-widget";
    widget.innerHTML = `
      <div class="tempmail-widget-header tempmail-otp-header">
        <div class="tempmail-widget-logo">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0110 0v4"/>
          </svg>
        </div>
        <span class="tempmail-widget-title">Verification code detected!</span>
        <button class="tempmail-widget-close" title="Close">&times;</button>
      </div>
      <div class="tempmail-widget-body">
        <div class="tempmail-otp-code">${code}</div>
        <div class="tempmail-otp-from">From: ${from || "Unknown"}</div>
        ${subject ? `<div class="tempmail-otp-subject">${subject}</div>` : ""}
      </div>
      <div class="tempmail-widget-actions">
        <button class="tempmail-btn tempmail-btn-fill">Auto-fill code</button>
        <button class="tempmail-btn tempmail-btn-copy-otp">Copy code</button>
      </div>
    `;

    document.body.appendChild(widget);

    widget.querySelector(".tempmail-widget-close").addEventListener("click", () => {
      widget.remove();
    });

    widget.querySelector(".tempmail-btn-fill").addEventListener("click", () => {
      const otpField = findOTPField();
      if (otpField) {
        otpField.value = code;
        otpField.dispatchEvent(new Event("input", { bubbles: true }));
        otpField.dispatchEvent(new Event("change", { bubbles: true }));
        const form = otpField.closest("form");
        if (form) {
          const submitBtn = form.querySelector(
            'button[type="submit"], input[type="submit"]'
          );
          if (submitBtn) {
            setTimeout(() => submitBtn.click(), 300);
          }
        }
      }
      widget.remove();
    });

    widget.querySelector(".tempmail-btn-copy-otp").addEventListener("click", () => {
      navigator.clipboard.writeText(code).then(() => {
        const btn = widget.querySelector(".tempmail-btn-copy-otp");
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = "Copy code";
        }, 1500);
      });
    });

    return widget;
  }

  function createVerificationLinkWidget(links, from, subject) {
    const existing = document.getElementById("tempmail-verify-widget");
    if (existing) existing.remove();

    const widget = document.createElement("div");
    widget.id = "tempmail-verify-widget";
    widget.className = "tempmail-widget tempmail-verify-widget";

    const linkButtons = links.slice(0, 2).map((link, i) => {
      const label = i === 0 ? "Open verification link" : "Open link";
      return `<button class="tempmail-btn tempmail-btn-fill tempmail-verify-link-btn" data-url="${link}">${label}</button>`;
    }).join("");

    widget.innerHTML = `
      <div class="tempmail-widget-header tempmail-verify-header">
        <div class="tempmail-widget-logo">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </div>
        <span class="tempmail-widget-title">Verification email received!</span>
        <button class="tempmail-widget-close" title="Close">&times;</button>
      </div>
      <div class="tempmail-widget-body">
        <div class="tempmail-verify-from">From: ${from || "Unknown"}</div>
        ${subject ? `<div class="tempmail-verify-subject">${subject}</div>` : ""}
        <div class="tempmail-verify-links">
          ${linkButtons}
        </div>
      </div>
      <div class="tempmail-widget-actions">
        <button class="tempmail-btn tempmail-btn-copy-link">Copy link</button>
      </div>
    `;

    document.body.appendChild(widget);

    widget.querySelector(".tempmail-widget-close").addEventListener("click", () => {
      widget.remove();
    });

    widget.querySelectorAll(".tempmail-verify-link-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const url = btn.getAttribute("data-url");
        window.open(url, "_blank");
        widget.remove();
      });
    });

    widget.querySelector(".tempmail-btn-copy-link").addEventListener("click", () => {
      navigator.clipboard.writeText(links[0]).then(() => {
        const btn = widget.querySelector(".tempmail-btn-copy-link");
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = "Copy link";
        }, 1500);
      });
    });

    return widget;
  }

  // ============================================================================
  // Form Observer
  // ============================================================================

  function scanForForms() {
    // 1. Update datalist on all email fields
    if (emailData) {
      updateDatalist();
    }

    // 2. Check for registration forms (classic)
    const forms = document.querySelectorAll("form");
    forms.forEach((form) => {
      if (observedForms.has(form)) return;
      observedForms.add(form);

      if (isRegistrationForm(form)) {
        const emailField = findEmailField(form);
        const passwordField = findPasswordField(form);

        if (emailField && emailData && !emailField.value) {
          showRegistrationPrompt(emailField, passwordField);
        }
      }
    });

    // 3. Check for OTP fields
    if (otpDetected && settings.otpAutoFill) {
      const otpField = findOTPField();
      if (otpField && !otpField.value) {
        showOTPWidget(otpDetected.code, otpDetected.from, otpDetected.subject);
      }
    }

    // 4. Check for verification links
    if (verificationLinks && verificationLinks.length > 0) {
      showVerificationWidget(
        verificationLinks,
        verificationLinksFrom,
        verificationLinksSubject
      );
    }
  }

  function showRegistrationPrompt(emailField, passwordField) {
    const existing = document.getElementById("tempmail-widget");
    if (existing) return;

    createPromptWidget(
      emailData.email,
      emailData.password,
      emailField,
      passwordField
    );
  }

  function showOTPWidget(code, from, subject) {
    createOTPWidget(code, from, subject);
  }

  function showVerificationWidget(links, from, subject) {
    createVerificationLinkWidget(links, from, subject);
  }

  // ============================================================================
  // Mutation Observer
  // ============================================================================

  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        shouldScan = true;
        break;
      }
    }
    if (shouldScan) {
      setTimeout(scanForForms, 100);
    }
  });

  // ============================================================================
  // Message Listener
  // ============================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case "emailCreated":
        emailData = { email: message.email, password: message.password };
        updateDatalist();
        scanForForms();
        break;

      case "emailData":
        emailData = message.data;
        updateDatalist();
        scanForForms();
        break;

      case "otpDetected":
        otpDetected = {
          code: message.code,
          from: message.from,
          subject: message.subject,
        };
        if (settings.otpAutoFill) {
          const otpField = findOTPField();
          if (otpField && !otpField.value) {
            showOTPWidget(message.code, message.from, message.subject);
          }
        }
        break;

      case "verificationLinkDetected":
        verificationLinks = message.links;
        verificationLinksFrom = message.from;
        verificationLinksSubject = message.subject;
        showVerificationWidget(message.links, message.from, message.subject);
        break;

      case "settings":
        settings = message.settings;
        break;
    }
  });

  // ============================================================================
  // Initialization
  // ============================================================================

  async function init() {
    settings = await chrome.storage.local.get([
      "autoFillEnabled",
      "autoGeneratePassword",
      "otpAutoFill",
      "showNotification",
    ]);

    const saved = await chrome.storage.local.get([
      "currentEmail",
      "currentPassword",
    ]);
    if (saved.currentEmail) {
      emailData = {
        email: saved.currentEmail,
        password: saved.currentPassword || "",
      };
      updateDatalist();
    }

    scanForForms();

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    setInterval(scanForForms, 2000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
