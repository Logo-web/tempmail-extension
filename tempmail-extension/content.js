// ============================================================================
// TempMail AutoFill - Content Script
// ============================================================================

(function () {
  "use strict";

  let emailData = null;
  let otpDetected = null;
  let verificationLinks = null;
  let verificationLinksFrom = "";
  let verificationLinksSubject = "";
  let settings = {};
  let hasShownPrompt = false;
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

  function findStandaloneEmailFields() {
    const fields = [];
    for (const selector of EMAIL_FIELD_SELECTORS) {
      document.querySelectorAll(selector).forEach((field) => {
        if (
          field.type !== "hidden" &&
          field.offsetParent !== null &&
          !field.disabled &&
          !field.readOnly &&
          !field.value &&
          !fields.includes(field)
        ) {
          // Check if field is near registration-related text
          const parent = field.closest("div, section, main, article, form") || field.parentElement;
          if (parent) {
            const contextText = parent.textContent.toLowerCase();
            const isNearSignup = PAGE_INDICATORS.some((p) =>
              new RegExp(p, "i").test(contextText)
            );
            if (isNearSignup) {
              fields.push(field);
            }
          }
        }
      });
    }
    return fields;
  }

  function extractVerificationLinks(text) {
    if (!text) return [];
    const urls = text.match(/https?:\/\/[^\s"'>]+/g) || [];
    return urls.filter((url) => {
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
        lower.includes("reset-password")
      );
    });
  }

  // ============================================================================
  // UI Components
  // ============================================================================

  function createInlineEmailWidget(email, emailField) {
    // Remove existing inline widgets for this field
    const existingId = `tempmail-inline-${emailField.dataset.tempmailId || ""}`;
    const existing = document.getElementById(existingId);
    if (existing) existing.remove();

    const wrapper = document.createElement("div");
    wrapper.id = existingId || `tempmail-inline-${Date.now()}`;
    wrapper.className = "tempmail-inline-widget";
    wrapper.innerHTML = `
      <div class="tempmail-inline-content">
        <span class="tempmail-inline-email">${email}</span>
        <div class="tempmail-inline-actions">
          <button class="tempmail-inline-btn tempmail-inline-fill" title="Fill email">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
            Fill
          </button>
          <button class="tempmail-inline-btn tempmail-inline-copy" title="Copy email">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <rect x="9" y="9" width="13" height="13" rx="2"/>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>
          </button>
          <button class="tempmail-inline-btn tempmail-inline-dismiss" title="Dismiss">&times;</button>
        </div>
      </div>
    `;

    // Insert after the email field
    emailField.parentNode.insertBefore(wrapper, emailField.nextSibling);

    // Fill button
    wrapper.querySelector(".tempmail-inline-fill").addEventListener("click", () => {
      emailField.value = email;
      emailField.dispatchEvent(new Event("input", { bubbles: true }));
      emailField.dispatchEvent(new Event("change", { bubbles: true }));
      
      // Also try to find and fill a nearby submit button
      const form = emailField.closest("form");
      if (form) {
        const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], [data-testid*="submit"]');
        if (submitBtn && submitBtn.offsetParent !== null) {
          // Highlight the submit button to indicate user should click it
          submitBtn.style.outline = "2px solid #6366f1";
          submitBtn.style.outlineOffset = "2px";
          setTimeout(() => {
            submitBtn.style.outline = "";
            submitBtn.style.outlineOffset = "";
          }, 2000);
        }
      }
      wrapper.remove();
    });

    // Copy button
    wrapper.querySelector(".tempmail-inline-copy").addEventListener("click", () => {
      navigator.clipboard.writeText(email).then(() => {
        const btn = wrapper.querySelector(".tempmail-inline-copy");
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>`;
        setTimeout(() => wrapper.remove(), 800);
      });
    });

    // Dismiss button
    wrapper.querySelector(".tempmail-inline-dismiss").addEventListener("click", () => {
      wrapper.remove();
    });

    return wrapper;
  }

  function createPromptWidget(email, password, emailField, passwordField) {
    // Remove existing widget
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

    // Event listeners
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

    // Copy buttons
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
        
        // Try to submit if there's a form
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

    // Open link buttons
    widget.querySelectorAll(".tempmail-verify-link-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const url = btn.getAttribute("data-url");
        window.open(url, "_blank");
        widget.remove();
      });
    });

    // Copy link button
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
    // 1. Check for registration forms (classic)
    const forms = document.querySelectorAll("form");
    forms.forEach((form) => {
      if (observedForms.has(form)) return;
      observedForms.add(form);

      if (isRegistrationForm(form)) {
        const emailField = findEmailField(form);
        const passwordField = findPasswordField(form);

        if (emailField && emailData) {
          if (!emailField.value) {
            showRegistrationPrompt(emailField, passwordField);
          }
        }
      }
    });

    // 2. Check for standalone email fields on registration pages (SPA-style)
    if (!hasShownPrompt && emailData && isRegistrationPage()) {
      const standaloneFields = findStandaloneEmailFields();
      if (standaloneFields.length > 0) {
        hasShownPrompt = true;
        standaloneFields.forEach((field) => {
          createInlineEmailWidget(emailData.email, field);
        });
      }
    }

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
    if (hasShownPrompt) return;
    hasShownPrompt = true;

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
        hasShownPrompt = false;
        scanForForms();
        break;

      case "emailData":
        emailData = message.data;
        hasShownPrompt = false;
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
    // Load settings
    settings = await chrome.storage.local.get([
      "autoFillEnabled",
      "autoGeneratePassword",
      "otpAutoFill",
      "showNotification",
    ]);

    // Load email data
    const saved = await chrome.storage.local.get([
      "currentEmail",
      "currentPassword",
    ]);
    if (saved.currentEmail) {
      emailData = {
        email: saved.currentEmail,
        password: saved.currentPassword || "",
      };
    }

    // Start scanning
    scanForForms();

    // Observe DOM changes
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Also scan periodically for SPAs
    setInterval(scanForForms, 2000);
  }

  // Wait for DOM to be ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
