// ============================================================================
// TempMail AutoFill - Content Script
// ============================================================================

(function () {
  "use strict";

  const DATALIST_ID = "tempmail-autocomplete-list";
  const DATALIST_ID_PW = "tempmail-autocomplete-list-pw";

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

  function ensureEmailDatalist() {
    let datalist = document.getElementById(DATALIST_ID);
    if (!datalist) {
      datalist = document.createElement("datalist");
      datalist.id = DATALIST_ID;
      document.body.appendChild(datalist);
      hasInjectedDatalist = true;
    }
    return datalist;
  }

  function ensurePasswordDatalist() {
    let datalist = document.getElementById(DATALIST_ID_PW);
    if (!datalist) {
      datalist = document.createElement("datalist");
      datalist.id = DATALIST_ID_PW;
      document.body.appendChild(datalist);
      hasInjectedDatalist = true;
    }
    return datalist;
  }

  function updateDatalists() {
    if (!emailData || !emailData.email) return;

    // Update email datalist - update option in place to avoid closing dropdown
    let emailDatalist = document.getElementById(DATALIST_ID);
    if (!emailDatalist) {
      emailDatalist = document.createElement("datalist");
      emailDatalist.id = DATALIST_ID;
      document.body.appendChild(emailDatalist);
      const emailOption = document.createElement("option");
      emailOption.value = emailData.email;
      emailDatalist.appendChild(emailOption);
    } else {
      // Update existing option value instead of clearing (prevents dropdown close)
      const existingOption = emailDatalist.querySelector("option");
      if (existingOption) {
        existingOption.value = emailData.email;
      } else {
        const emailOption = document.createElement("option");
        emailOption.value = emailData.email;
        emailDatalist.appendChild(emailOption);
      }
    }

    // Update password datalist
    let pwDatalist = document.getElementById(DATALIST_ID_PW);
    if (!pwDatalist) {
      pwDatalist = document.createElement("datalist");
      pwDatalist.id = DATALIST_ID_PW;
      document.body.appendChild(pwDatalist);
      if (emailData.password) {
        const pwOption = document.createElement("option");
        pwOption.value = emailData.password;
        pwDatalist.appendChild(pwOption);
      }
    } else {
      if (emailData.password) {
        const existingOption = pwDatalist.querySelector("option");
        if (existingOption) {
          existingOption.value = emailData.password;
        } else {
          const pwOption = document.createElement("option");
          pwOption.value = emailData.password;
          pwDatalist.appendChild(pwOption);
        }
      }
    }

    // Always attach to all fields
    attachEmailDatalist(true);
    attachPasswordDatalist(true);
  }

  function attachEmailDatalist(force = false) {
    const datalist = document.getElementById(DATALIST_ID);
    if (!datalist) return;

    const emailFields = findAllEmailFields();
    emailFields.forEach((field) => {
      const hasList = field.getAttribute("list") === DATALIST_ID;
      if (force || !hasList) {
        field.setAttribute("list", DATALIST_ID);
        field.setAttribute("autocomplete", "email");

        if (!field.dataset.tempmailAttached) {
          field.dataset.tempmailAttached = "true";
          addTempmailIndicator(field);
          field.addEventListener("focus", refreshFromStorage);
        }
      }
    });
  }

  function attachPasswordDatalist(force = false) {
    const datalist = document.getElementById(DATALIST_ID_PW);
    if (!datalist) return;

    const pwFields = findAllPasswordFields();
    pwFields.forEach((field) => {
      const hasList = field.getAttribute("list") === DATALIST_ID_PW;
      if (force || !hasList) {
        field.setAttribute("list", DATALIST_ID_PW);
        field.setAttribute("autocomplete", "new-password");

        if (!field.dataset.tempmailPwAttached) {
          field.dataset.tempmailPwAttached = "true";
          addPasswordIndicator(field);
          field.addEventListener("focus", refreshFromStorage);
        }
      }
    });
  }

  async function refreshFromStorage() {
    const saved = await chrome.storage.local.get(["currentEmail", "currentPassword"]);
    if (saved.currentEmail) {
      const newEmail = {
        email: saved.currentEmail,
        password: saved.currentPassword || "",
      };
      // Only update if different
      if (!emailData || emailData.email !== newEmail.email) {
        emailData = newEmail;
        updateDatalists();
      }
    }
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

  function findAllPasswordFields() {
    const fields = [];
    for (const selector of PASSWORD_FIELD_SELECTORS) {
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
    const wrapper = document.createElement("div");
    wrapper.className = "tempmail-field-wrapper";
    wrapper.style.position = "relative";
    wrapper.style.display = "inline-block";
    wrapper.style.width = "100%";

    field.parentNode.insertBefore(wrapper, field);
    wrapper.appendChild(field);

    const badge = document.createElement("div");
    badge.className = "tempmail-field-badge";
    badge.innerHTML = `
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <rect x="2" y="4" width="20" height="16" rx="2"/>
        <path d="M22 4L12 13L2 4"/>
      </svg>
    `;
    badge.title = "Click to fill temp email";
    wrapper.appendChild(badge);

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

  function addPasswordIndicator(field) {
    const wrapper = document.createElement("div");
    wrapper.className = "tempmail-field-wrapper";
    wrapper.style.position = "relative";
    wrapper.style.display = "inline-block";
    wrapper.style.width = "100%";

    field.parentNode.insertBefore(wrapper, field);
    wrapper.appendChild(field);

    const badge = document.createElement("div");
    badge.className = "tempmail-field-badge tempmail-pw-badge";
    badge.innerHTML = `
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <rect x="3" y="11" width="18" height="11" rx="2"/>
        <path d="M7 11V7a5 5 0 0110 0v4"/>
      </svg>
    `;
    badge.title = "Click to fill generated password";
    wrapper.appendChild(badge);

    badge.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (emailData && emailData.password) {
        field.value = emailData.password;
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

  let datalistsAttached = false;

  function scanForForms() {
    // 1. Attach datalists to fields (only once per page load)
    if (emailData && !datalistsAttached) {
      updateDatalists();
      datalistsAttached = true;
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
    if (existing) {
      // Update existing widget with new email
      const emailText = existing.querySelector(".tempmail-email-text");
      const pwText = existing.querySelector(".tempmail-password-text");
      const fillBtn = existing.querySelector(".tempmail-btn-fill");
      const copyEmailBtn = existing.querySelector(".tempmail-copy-btn[data-copy]");
      const copyPwBtn = existing.querySelectorAll(".tempmail-copy-btn[data-copy]");
      if (emailText) emailText.textContent = emailData.email;
      if (pwText) pwText.textContent = emailData.password;
      if (copyEmailBtn) copyEmailBtn.setAttribute("data-copy", emailData.email);
      if (copyPwBtn && copyPwBtn[1]) copyPwBtn[1].setAttribute("data-copy", emailData.password);
      if (fillBtn) {
        fillBtn.onclick = () => {
          if (emailField) {
            emailField.value = emailData.email;
            emailField.dispatchEvent(new Event("input", { bubbles: true }));
            emailField.dispatchEvent(new Event("change", { bubbles: true }));
          }
          if (passwordField) {
            passwordField.value = emailData.password;
            passwordField.dispatchEvent(new Event("input", { bubbles: true }));
            passwordField.dispatchEvent(new Event("change", { bubbles: true }));
          }
          existing.remove();
        };
      }
      return;
    }

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
  // Listen for storage changes (survives service worker restarts)
  // ============================================================================

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    console.log("[TempMail] Storage changed:", Object.keys(changes));

    if (changes.currentEmail || changes.currentPassword) {
      const newEmail = changes.currentEmail?.newValue || emailData?.email || "";
      const newPw = changes.currentPassword?.newValue || emailData?.password || "";
      console.log("[TempMail] Email updated:", newEmail);

      emailData = {
        email: newEmail,
        password: newPw,
      };

      // Update existing prompt widget if visible
      const existingWidget = document.getElementById("tempmail-widget");
      if (existingWidget) {
        const emailText = existingWidget.querySelector(".tempmail-email-text");
        const pwText = existingWidget.querySelector(".tempmail-password-text");
        const copyEmailBtn = existingWidget.querySelector('.tempmail-copy-btn[data-copy]');
        const copyPwBtns = existingWidget.querySelectorAll('.tempmail-copy-btn[data-copy]');
        if (emailText) emailText.textContent = newEmail;
        if (pwText) pwText.textContent = newPw;
        if (copyEmailBtn) copyEmailBtn.setAttribute("data-copy", newEmail);
        if (copyPwBtns && copyPwBtns[1]) copyPwBtns[1].setAttribute("data-copy", newPw);
        // Update fill button onclick
        const fillBtn = existingWidget.querySelector(".tempmail-btn-fill");
        if (fillBtn) {
          fillBtn.replaceWith(fillBtn.cloneNode(true));
          existingWidget.querySelector(".tempmail-btn-fill").addEventListener("click", () => {
            const ef = findEmailField(document) || document.querySelector('input[type="email"], input[name*="email" i]');
            const pf = findPasswordField(document) || document.querySelector('input[type="password"]');
            if (ef) {
              ef.value = newEmail;
              ef.dispatchEvent(new Event("input", { bubbles: true }));
              ef.dispatchEvent(new Event("change", { bubbles: true }));
            }
            if (pf) {
              pf.value = newPw;
              pf.dispatchEvent(new Event("input", { bubbles: true }));
              pf.dispatchEvent(new Event("change", { bubbles: true }));
            }
            existingWidget.remove();
          });
        }
      }

      if (emailData.email) {
        console.log("[TempMail] Updating datalists and scanning forms");
        updateDatalists();
        scanForForms();
      }
    }

    if (changes.inboxMessages) {
      const newMessages = changes.inboxMessages.newValue || [];
      const oldMessages = changes.inboxMessages.oldValue || [];
      if (newMessages.length > oldMessages.length) {
        const added = newMessages.slice(0, newMessages.length - oldMessages.length);
        for (const msg of added) {
          const text = msg.body || msg.subject || "";
          const otp = extractOTP(text);
          if (otp) {
            otpDetected = {
              code: otp,
              from: msg.from || msg.from_email || "",
              subject: msg.subject || "",
            };
            if (settings.otpAutoFill) {
              const otpField = findOTPField();
              if (otpField && !otpField.value) {
                showOTPWidget(otp, otpDetected.from, otpDetected.subject);
              }
            }
          }
          // Check for verification links
          const body = msg.body || msg.body_html || "";
          const links = extractVerificationLinks(body);
          if (links.length > 0) {
            verificationLinks = links;
            verificationLinksFrom = msg.from || msg.from_email || "";
            verificationLinksSubject = msg.subject || "";
            showVerificationWidget(links, verificationLinksFrom, verificationLinksSubject);
          }
        }
      }
    }
  });

  // ============================================================================
  // Message Listener
  // ============================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case "emailCreated":
        emailData = { email: message.email, password: message.password };
        updateDatalists();
        scanForForms();
        break;

      case "emailData":
        emailData = message.data;
        updateDatalists();
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
  // SmailPro Gmail/Outlook Auto-Creation
  // ============================================================================

  function setupSmailProAutoCreate() {
    if (!window.location.hostname.includes("smailpro.com")) return;
    if (!window.location.pathname.includes("temporary-email")) return;

    console.log("[TempMail] SmailPro page detected, setting up auto-create");

    // Check URL params for email type
    const urlParams = new URLSearchParams(window.location.search);
    const emailType = urlParams.get("emailType"); // gmail or outlook

    if (!emailType) return;

    console.log("[TempMail] Auto-creating", emailType, "email");

    // Wait for Alpine.js to initialize, then click generate
    const waitForAlpine = setInterval(() => {
      // Look for the create function (Alpine component)
      const createComponent = window.Alpine?.$data?.(document.querySelector("[x-data]"));

      // Try to find and click the generate button
      const generateBtn = document.querySelector('[x-on\\:click*="generate"], button:has-text("Generate")');
      const createBtn = document.querySelector('button:has-text("Create"), [x-on\\:click*="create"]');

      // Try clicking various buttons
      const allButtons = document.querySelectorAll("button");
      for (const btn of allButtons) {
        const text = btn.textContent.trim().toLowerCase();
        if (text === "generate" || text === "create" || text.includes("generate")) {
          console.log("[TempMail] Found generate button:", text);
          btn.click();
          clearInterval(waitForAlpine);
          break;
        }
      }

      // If no button found, try calling the Alpine function directly
      if (!generateBtn && !createBtn) {
        // Look for the generate function in Alpine store
        const alpineEls = document.querySelectorAll("[x-data]");
        for (const el of alpineEls) {
          const data = el.__x?.__data;
          if (data && typeof data.generate === "function") {
            console.log("[TempMail] Calling generate function");
            data.generate(true);
            clearInterval(waitForAlpine);
            break;
          }
        }
      }
    }, 500);

    // Timeout after 15 seconds
    setTimeout(() => clearInterval(waitForAlpine), 15000);

    // Watch for the created email
    const checkForEmail = setInterval(() => {
      // Look for the email display
      const emailDisplay = document.querySelector(".email-display, [x-text*='email'], .created-email");
      if (emailDisplay) {
        const emailText = emailDisplay.textContent.trim();
        const emailMatch = emailText.match(/[\w.+-]+@(gmail\.com|googlemail\.com|outlook\.com|hotmail\.com|outlook\.\w+)/i);
        if (emailMatch) {
          const email = emailMatch[0];
          console.log("[TempMail] Email created:", email);
          clearInterval(checkForEmail);

          const action = emailType === "gmail" ? "gmailCreated" : "outlookCreated";
          chrome.runtime.sendMessage({
            action: action,
            email: email,
          });
        }
      }

      // Also check for the email in the input field or display
      const emailInputs = document.querySelectorAll('input[type="text"], input[type="email"]');
      for (const input of emailInputs) {
        if (input.value && (input.value.includes("@gmail.com") || input.value.includes("@outlook.com"))) {
          console.log("[TempMail] Email found in input:", input.value);
          clearInterval(checkForEmail);

          const action = emailType === "gmail" ? "gmailCreated" : "outlookCreated";
          chrome.runtime.sendMessage({
            action: action,
            email: input.value,
          });
          break;
        }
      }
    }, 1000);

    // Timeout after 30 seconds
    setTimeout(() => clearInterval(checkForEmail), 30000);
  }

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
      updateDatalists();
    }

    // Setup smailpro auto-create if on that page
    setupSmailProAutoCreate();

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

  // ============================================================================
  // Test Helper - exposed as window.tempmailTest
  // ============================================================================
  // Expose debug interface immediately
  window.__tempmailDebug = {
  // Test/Debug interface
  window.__tempmailDebug = {
    version: "1.0",
    initialized: true,
    emailData: emailData,
  };
  console.log("[TempMail] Content script loaded, __tempmailDebug available");
  
  window.tempmailTest = {
    async getEmail() {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "getEmail" }, resolve);
      });
    },
    async createEmail() {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "createEmail" }, resolve);
      });
    },
    async createGmail() {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "createGmail" }, resolve);
      });
    },
    async createOutlook() {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "createOutlook" }, resolve);
      });
    },
    async checkInbox() {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "checkInbox" }, resolve);
      });
    },
    async getOTP() {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "getOTP" }, resolve);
      });
    },
    async deleteEmail() {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "deleteEmail" }, resolve);
      });
    },
    logState() {
      console.log("[TempMail Test] Current email:", emailData);
      console.log("[TempMail Test] OTP detected:", otpDetected);
      console.log("[TempMail Test] Verification links:", verificationLinks);
    },
    // Direct debug - logs to PAGE console
    async debug() {
      const state = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "getEmail" }, resolve);
      });
      console.log("[TempMail Debug] Full state:", JSON.stringify(state, null, 2));
      
      // Also try to check inbox directly
      console.log("[TempMail Debug] Calling checkInbox...");
      const messages = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "checkInbox" }, resolve);
      });
      console.log("[TempMail Debug] Inbox messages:", messages);
      return { state, messages };
    }
  };
  console.log("[TempMail] Test helper available as window.tempmailTest");
  console.log("[TempMail] Run tempmailTest.debug() to debug inbox issues");
})();
