// ============================================================================
// TempMail AutoFill - Background Service Worker
// ============================================================================

const BASE_API_URL = "https://api.sonjj.com/v1/temp_email";
const PAYLOAD_URL = "https://smailpro.com/app/payload";
const SMAILPRO_CREATE_URL = "https://smailpro.com/app/create";
const RECAPTCHA_SITE_KEY = "6Ldd8-IUAAAAAIdqbOociFKyeBGFsp3nNUM_6_SC";

// State
let currentEmail = null;
let currentPassword = null;
let inboxMessages = [];
let isPolling = false;
let emailCreatedAt = null;
let consecutiveFailures = 0;
let isEmailDead = false;
let emailKey = null;
let emailType = "other";
const MAX_CONSECUTIVE_FAILURES = 5;

// ============================================================================
// reCAPTCHA V3 Bypass (ported from freecaptcha Python library)
// ============================================================================

async function solveRecaptchaV3() {
  // Step 1: Get anchor page
  const anchorUrl = `https://www.google.com/recaptcha/api2/anchor?ar=1&k=${RECAPTCHA_SITE_KEY}&co=aHR0cHM6Ly9zbWFpbHByby5jb206NDQz&hl=en&v=abc123&size=invisible&cb=smailpro`;

  const anchorResp = await fetch(anchorUrl);
  const anchorHtml = await anchorResp.text();

  // Extract recaptcha-token
  const tokenMatch = anchorHtml.match(/id="recaptcha-token"\s*value="(.*?)"/);
  if (!tokenMatch) {
    throw new Error("Failed to extract recaptcha-token from anchor");
  }

  const recapToken = tokenMatch[1];

  // Step 2: Send reload request
  const reloadUrl = `https://www.google.com/recaptcha/api2/reload?k=${RECAPTCHA_SITE_KEY}`;

  const params = new URLSearchParams();
  params.set("v", "abc123");
  params.set("reason", "q");
  params.set("c", recapToken);
  params.set("k", RECAPTCHA_SITE_KEY);
  params.set("co", "aHR0cHM6Ly9zbWFpbHByby5jb206NDQz");
  params.set("hl", "en");
  params.set("size", "invisible");
  params.set("chr", "");
  params.set("vh", "");
  params.set("bg", "");
  params.set("ar", "1");

  const reloadResp = await fetch(reloadUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const reloadText = await reloadResp.text();

  // Parse response - it's JSON prefixed with ")]}'\n"
  const jsonStr = reloadText.substring(5);
  const data = JSON.parse(jsonStr);
  return data[1]; // Token is at index 1
}

// ============================================================================
// Gmail/Outlook Creation via smailpro.com
// ============================================================================

async function createGmailOrOutlook(type = "google") {
  console.log(`[TempMail] Creating ${type} email...`);

  // Solve reCAPTCHA
  let captchaToken;
  try {
    captchaToken = await solveRecaptchaV3();
    console.log("[TempMail] Captcha solved, token length:", captchaToken.length);
  } catch (e) {
    console.error("[TempMail] Captcha solve failed:", e);
    return null;
  }

  // First get the page to establish session cookies
  await fetch("https://smailpro.com/temporary-email", {
    method: "GET",
    credentials: "include",
  });

  // Build request
  const domain = type === "google" ? "gmail.com" : "outlook.com";
  const params = new URLSearchParams({
    username: "random",
    type: "alias",
    domain: domain,
    server: "1",
  });

  const resp = await fetch(`${SMAILPRO_CREATE_URL}?${params.toString()}`, {
    method: "GET",
    credentials: "include",
    headers: {
      "Accept": "application/json",
      "x-captcha": captchaToken,
    },
  });

  if (!resp.ok) {
    const error = await resp.json().catch(() => ({}));
    console.error("[TempMail] Create email failed:", error);
    return null;
  }

  const data = await resp.json();
  console.log("[TempMail] Created:", data);
  console.log("[TempMail] Full response:", JSON.stringify(data, null, 2));

  currentEmail = data.address;
  currentPassword = generatePassword();
  inboxMessages = [];
  emailCreatedAt = Date.now();
  consecutiveFailures = 0;
  isEmailDead = false;
  emailKey = data.key || null;
  emailType = type;

  console.log("[TempMail] Extracted key:", emailKey ? emailKey.substring(0, 50) + "..." : "null");

  // Clear all state first, then set new values
  await chrome.storage.local.clear();
  await chrome.storage.local.set({
    currentEmail: data.address,
    currentPassword: currentPassword,
    emailTimestamp: data.timestamp * 1000,
    emailType: type,
    emailCreatedAt: Date.now(),
    isEmailDead: false,
    emailKey: emailKey,
  });

  console.log("[TempMail] Email created and state saved, type:", type);

  // Notify all tabs
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: "emailCreated",
          email: currentEmail,
          password: currentPassword,
        });
      } catch (e) {}
    }
  } catch (e) {}

  chrome.runtime.sendMessage({
    action: "emailCreated",
    email: currentEmail,
    password: currentPassword,
  }).catch(() => {});

  startInboxPolling();

  return { email: currentEmail, password: currentPassword, type: type };
}

// ============================================================================
// Initialization
// ============================================================================

async function restoreState() {
  const saved = await chrome.storage.local.get([
    "currentEmail",
    "currentPassword",
    "inboxMessages",
    "emailCreatedAt",
    "isEmailDead",
    "emailKey",
    "emailType",
  ]);
  if (saved.currentEmail) {
    currentEmail = saved.currentEmail;
    currentPassword = saved.currentPassword || null;
    inboxMessages = saved.inboxMessages || [];
    emailCreatedAt = saved.emailCreatedAt || null;
    isEmailDead = saved.isEmailDead || false;
    emailKey = saved.emailKey || null;
    emailType = saved.emailType || "other";
    console.log("[TempMail] Restored state:", currentEmail, isEmailDead ? "(DEAD)" : "", `(${emailType})`);
    startInboxPolling();
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[TempMail] Extension installed");

  // Set default settings
  await chrome.storage.local.set({
    autoFillEnabled: true,
    autoGeneratePassword: true,
    passwordLength: 16,
    autoCheckInbox: true,
    inboxPollInterval: 5000,
    showNotification: true,
    otpAutoFill: true,
  });

  await restoreState();
});

// Restore state on every service worker wakeup
chrome.runtime.onStartup.addListener(async () => {
  console.log("[TempMail] Service worker started");
  await restoreState();
});

// Also restore on message if state is empty
async function ensureState() {
  if (!currentEmail) {
    await restoreState();
  }
}

// ============================================================================
// Gmail/Outlook Inbox API
// ============================================================================

async function checkGmailOutlookInbox() {
  if (!currentEmail) return [];

  console.log("[TempMail] checkGmailOutlookInbox called, email:", currentEmail, "key:", emailKey ? "present" : "null");

  // Gmail/Outlook uses api.sonjj.com with GET and JWT key as payload
  if (!emailKey) {
    console.log("[TempMail] Gmail/Outlook inbox: no key available, incrementing failures");
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !isEmailDead) {
      isEmailDead = true;
      await chrome.storage.local.set({ isEmailDead: true });
      notifyEmailDead();
    }
    return inboxMessages;
  }

  try {
    // Try with JWT payload first (smailpro.com's custom API)
    const inboxUrl = `https://api.sonjj.com/v1/temp_gmail/inbox?payload=${encodeURIComponent(emailKey)}`;
    console.log("[TempMail] Checking Gmail/Outlook inbox:", inboxUrl);

    const response = await fetch(inboxUrl, {
      method: "GET",
      credentials: "include",
      headers: {
        "Referer": "https://smailpro.com/temporary-email",
        "Origin": "https://smailpro.com",
      },
    });

    console.log("[TempMail] Gmail/Outlook inbox response:", response.status, response.statusText);

    if (!response.ok) {
      const text = await response.text();
      console.log("[TempMail] Gmail/Outlook inbox error response:", text.substring(0, 500));
      consecutiveFailures++;
      console.warn(`[TempMail] Gmail/Outlook inbox check failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !isEmailDead) {
        isEmailDead = true;
        await chrome.storage.local.set({ isEmailDead: true });
        notifyEmailDead();
      }
      return inboxMessages;
    }

    const data = await response.json();
    console.log("[TempMail] Gmail/Outlook inbox data:", JSON.stringify(data, null, 2));

    // Even if no messages, a valid API response means the email is alive
    consecutiveFailures = 0;
    isEmailDead = false;
    await chrome.storage.local.set({ isEmailDead: false });

    // Handle different response formats
    let messages = data;
    if (data && data.messages) {
      messages = data.messages;
    } else if (data && Array.isArray(data)) {
      messages = data;
    } else if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
      console.log("[TempMail] Gmail/Outlook inbox: empty but valid response, keeping email alive");
      return inboxMessages;
    }
    
    console.log("[TempMail] Gmail/Outlook messages:", JSON.stringify(messages));

    const existingMids = new Set(inboxMessages.map((m) => m.mid));
    let newMessages = [];

    for (const msg of messages) {
      if (!existingMids.has(msg.mid)) {
        newMessages.push(msg);
        inboxMessages.unshift(msg);
      }
    }

    if (newMessages.length > 0) {
      chrome.runtime.sendMessage({
        action: "newMessages",
        messages: newMessages,
        count: inboxMessages.length,
      }).catch(() => {});

      checkForOTP(newMessages);
      checkForVerificationLinks(newMessages);
    }

    await chrome.storage.local.set({ inboxMessages });
    return inboxMessages;
  } catch (e) {
    console.error("[TempMail] Gmail/Outlook inbox error:", e);
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !isEmailDead) {
      isEmailDead = true;
      await chrome.storage.local.set({ isEmailDead: true });
      notifyEmailDead();
    }
    return inboxMessages;
  }
}

// ============================================================================
// SmailPro API
// ============================================================================

async function getPayload(url, email = null, mid = null) {
  const params = new URLSearchParams({ url });
  if (email) params.set("email", email);
  if (mid) params.set("mid", mid);

  const targetUrl = `${PAYLOAD_URL}?${params.toString()}`;
  console.log("[TempMail] Fetching payload:", targetUrl.substring(0, 100));

  try {
    const response = await fetch(targetUrl);
    console.log("[TempMail] Payload response status:", response.status);
    
    if (response.status === 429) {
      const data = await response.json().catch(() => ({}));
      console.warn("[TempMail] Rate limited:", data.msg || "Too many requests");
      return null;
    }
    if (!response.ok) {
      console.warn(`[TempMail] Payload failed: ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (e) {
    console.error("[TempMail] Payload fetch error:", e.message);
    console.error("[TempMail] Target URL:", targetUrl);
    return null;
  }
}

async function apiRequest(endpoint, params = {}) {
  const url = new URL(`${BASE_API_URL}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  console.log("[TempMail] API request:", url.toString().substring(0, 150));

  try {
    const response = await fetch(url.toString());
    console.log("[TempMail] API response status:", response.status);
    
    if (!response.ok) {
      console.warn(`[TempMail] API failed: ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (e) {
    console.error("[TempMail] API fetch error:", e.message);
    console.error("[TempMail] Target URL:", url.toString());
    return null;
  }
}

async function createEmail(customName = null) {
  console.log("[TempMail] Creating new email...");
  try {
    const payload = await getPayload(`${BASE_API_URL}/create`, customName);
    if (!payload) {
      console.error("[TempMail] Failed to get payload");
      return null;
    }

    const params = { payload };
    if (customName) params.email = customName;

    const data = await apiRequest("/create", params);
    if (!data || !data.email) {
      console.error("[TempMail] API returned no email");
      return null;
    }

    currentEmail = data.email;
    currentPassword = generatePassword();
    inboxMessages = [];
    emailCreatedAt = Date.now();
    consecutiveFailures = 0;
    isEmailDead = false;

    console.log("[TempMail] New email created:", currentEmail);

    await chrome.storage.local.set({
      currentEmail: data.email,
      currentPassword: currentPassword,
      emailTimestamp: data.timestamp || Date.now(),
      emailCreatedAt: Date.now(),
      isEmailDead: false,
    });

    // Notify all tabs
    try {
      const tabs = await chrome.tabs.query({});
      console.log("[TempMail] Notifying", tabs.length, "tabs");
      for (const tab of tabs) {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            action: "emailCreated",
            email: currentEmail,
            password: currentPassword,
          });
        } catch (e) {
          // Tab may not have content script loaded
        }
      }
    } catch (e) {
      console.error("[TempMail] Error notifying tabs:", e);
    }

    // Also broadcast via runtime (for popup etc)
    chrome.runtime.sendMessage({
      action: "emailCreated",
      email: currentEmail,
      password: currentPassword,
    }).catch(() => {});

    // Start polling
    startInboxPolling();

    return { email: currentEmail, password: currentPassword };
  } catch (e) {
    console.error("[TempMail] createEmail error:", e);
    return null;
  }
}

async function checkInbox() {
  if (!currentEmail) return [];

  if (emailType === "google" || emailType === "microsoft") {
    return await checkGmailOutlookInbox();
  }

  const payload = await getPayload(`${BASE_API_URL}/inbox`, currentEmail);
  if (!payload) {
    consecutiveFailures++;
    console.warn(`[TempMail] Inbox check failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !isEmailDead) {
      isEmailDead = true;
      await chrome.storage.local.set({ isEmailDead: true });
      notifyEmailDead();
    }
    return inboxMessages;
  }

  const data = await apiRequest("/inbox", { payload });
  if (!data || !data.messages) {
    consecutiveFailures++;
    console.warn(`[TempMail] Inbox check failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !isEmailDead) {
      isEmailDead = true;
      await chrome.storage.local.set({ isEmailDead: true });
      notifyEmailDead();
    }
    return inboxMessages;
  }

  consecutiveFailures = 0;
  
  const existingMids = new Set(inboxMessages.map((m) => m.mid));
  let newMessages = [];
  
  for (const msg of data.messages) {
    if (!existingMids.has(msg.mid)) {
      newMessages.push(msg);
      inboxMessages.unshift(msg);
    }
  }
  
  // Notify about new messages
  if (newMessages.length > 0) {
    chrome.runtime.sendMessage({
      action: "newMessages",
      messages: newMessages,
      count: inboxMessages.length,
    }).catch(() => {});
    
    // Check for OTP codes in new messages
    if (newMessages.length > 0) {
      checkForOTP(newMessages);
      checkForVerificationLinks(newMessages);
    }
  }
  
  await chrome.storage.local.set({ inboxMessages });
  return inboxMessages;
}

async function readMessage(mid) {
  if (!currentEmail) return null;

  if (emailType === "google" || emailType === "microsoft") {
    return await readGmailOutlookMessage(mid);
  }

  // Check cache
  const cached = inboxMessages.find((m) => m.mid === mid);
  if (cached && cached.body) return cached;

  const payload = await getPayload(`${BASE_API_URL}/message`, currentEmail, mid);
  if (!payload) return null;

  const data = await apiRequest("/message", { payload });
  if (!data) return null;

  // Update cache
  const idx = inboxMessages.findIndex((m) => m.mid === mid);
  if (idx >= 0) {
    inboxMessages[idx] = { ...inboxMessages[idx], ...data };
  } else {
    inboxMessages.unshift(data);
  }

  await chrome.storage.local.set({ inboxMessages });

  // Check for OTP
  checkForOTP([data]);
  checkForVerificationLinks([data]);

  return data;
}

async function readGmailOutlookMessage(mid) {
  if (!currentEmail) return null;

  const cached = inboxMessages.find((m) => m.mid === mid);
  if (cached && cached.body) return cached;

  // Gmail/Outlook uses api.sonjj.com with GET and JWT key as payload
  if (!emailKey) {
    console.log("[TempMail] Gmail/Outlook read message: no key available");
    return null;
  }

  try {
    const messageUrl = `https://api.sonjj.com/v1/temp_gmail/message?payload=${encodeURIComponent(emailKey)}&mid=${encodeURIComponent(mid)}`;
    console.log("[TempMail] Reading Gmail/Outlook message:", messageUrl);

    const response = await fetch(messageUrl, {
      credentials: "include",
      headers: {
        "Referer": "https://smailpro.com/temporary-email",
        "Origin": "https://smailpro.com",
      },
    });

    if (!response.ok) return null;

    const data = await response.json();
    console.log("[TempMail] Gmail/Outlook message:", data);

    // Update cache
    const idx = inboxMessages.findIndex((m) => m.mid === mid);
    if (idx >= 0) {
      inboxMessages[idx] = { ...inboxMessages[idx], ...data };
    } else {
      inboxMessages.unshift(data);
    }

    await chrome.storage.local.set({ inboxMessages });

    checkForOTP([data]);
    checkForVerificationLinks([data]);

    return data;
  } catch (e) {
    console.error("[TempMail] Gmail/Outlook read message error:", e);
    return null;
  }
}

// ============================================================================
// Email Dead Detection
// ============================================================================

function notifyEmailDead() {
  console.log("[TempMail] Email marked as dead");
  chrome.runtime.sendMessage({
    action: "emailDead",
  }).catch(() => {});
}

// ============================================================================
// OTP Detection
// ============================================================================

function extractOTP(text) {
  if (!text) return null;
  
  // Remove HTML tags
  const plainText = text.replace(/<[^>]+>/g, " ");
  
  // Common OTP patterns
  const patterns = [
    /(?:verification code|confirm|OTP|code|PIN|security code)[^0-9]*?(\d{4,8})/i,
    /(?:code|PIN)[^0-9]*?(\d{6})/i,
    /(\d{6})\s*(?:is your|is your code|is the)/i,
    /(?:your|the)\s+(?:verification|confirmation|security|OTP)\s+(?:code|number|PIN)\s+(?:is\s+)?(\d{4,8})/i,
    /(\d{4,8})\s+(?:is your|is the)\s+(?:verification|confirmation|security|OTP)/i,
    /(?:^|\s)(\d{4,8})(?:\s|$)/,
  ];
  
  for (const pattern of patterns) {
    const match = plainText.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

async function checkForOTP(messages) {
  const settings = await chrome.storage.local.get(["otpAutoFill", "showNotification"]);
  if (!settings.otpAutoFill) return;
  
  for (const msg of messages) {
    const text = msg.body || msg.subject || "";
    const otp = extractOTP(text);
    
    if (otp) {
      console.log("[TempMail] OTP detected:", otp);
      
      // Show notification
      if (settings.showNotification) {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "TempMail AutoFill",
          message: `Verification code detected: ${otp}`,
          priority: 2,
        });
      }
      
      // Send to content script
      chrome.runtime.sendMessage({
        action: "otpDetected",
        code: otp,
        from: msg.from || msg.from_email || "",
        subject: msg.subject || "",
      }).catch(() => {});
    }
  }
}

// ============================================================================
// Verification Link Detection
// ============================================================================

function extractVerificationLinks(text) {
  if (!text) return [];
  
  // Extract URLs from HTML href attributes
  const hrefUrls = text.match(/href=["'](https?:\/\/[^"']+)["']/gi) || [];
  const extracted = hrefUrls.map((match) => {
    const urlMatch = match.match(/href=["'](https?:\/\/[^"']+)["']/i);
    return urlMatch ? urlMatch[1] : null;
  }).filter(Boolean);
  
  // Also extract plain URLs
  const plainUrls = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
  
  const allUrls = [...new Set([...extracted, ...plainUrls])];
  
  // Filter for verification/auth-related URLs
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

async function checkForVerificationLinks(messages) {
  for (const msg of messages) {
    const body = msg.body || msg.body_html || "";
    const links = extractVerificationLinks(body);
    
    if (links.length > 0) {
      console.log("[TempMail] Verification links detected:", links);
      
      // Show notification
      const settings = await chrome.storage.local.get(["showNotification"]);
      if (settings.showNotification) {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "TempMail AutoFill",
          message: `Verification email received! Click to open the link.`,
          priority: 2,
        });
      }
      
      // Send to content script
      chrome.runtime.sendMessage({
        action: "verificationLinkDetected",
        links: links,
        from: msg.from || msg.from_email || "",
        subject: msg.subject || "",
      }).catch(() => {});
    }
  }
}

// ============================================================================
// Password Generation
// ============================================================================

function generatePassword(length = 16) {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const symbols = "!@#$%^&*()_+-=[]{}|;:,.<>?";
  const all = upper + lower + digits + symbols;
  
  let password = "";
  password += upper[Math.floor(Math.random() * upper.length)];
  password += lower[Math.floor(Math.random() * lower.length)];
  password += digits[Math.floor(Math.random() * digits.length)];
  password += symbols[Math.floor(Math.random() * symbols.length)];
  
  for (let i = 4; i < length; i++) {
    password += all[Math.floor(Math.random() * all.length)];
  }
  
  // Shuffle
  return password
    .split("")
    .sort(() => Math.random() - 0.5)
    .join("");
}

// ============================================================================
// Inbox Polling
// ============================================================================

function startInboxPolling() {
  if (isPolling) return;
  if (!currentEmail) return;
  
  isPolling = true;
  
  // Use chrome.alarms for reliable background polling in MV3
  chrome.alarms.create("inboxPoll", { periodInMinutes: 0.083 }); // ~5 seconds
}

function stopInboxPolling() {
  chrome.alarms.clear("inboxPoll");
  isPolling = false;
}

// ============================================================================
// Message Handlers
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case "createEmail":
      createEmail(message.customName).then((result) => {
        sendResponse(result);
      });
      return true; // async

    case "createGmail":
      createGmailOrOutlook("google").then((result) => {
        sendResponse(result);
      });
      return true; // async

    case "createOutlook":
      createGmailOrOutlook("microsoft").then((result) => {
        sendResponse(result);
      });
      return true; // async
    
    case "getEmail":
      ensureState().then(() => {
        sendResponse({
          email: currentEmail,
          password: currentPassword,
          messages: inboxMessages,
          isDead: isEmailDead,
        });
      });
      return true; // async
    
    case "checkInbox":
      ensureState().then(() => {
        checkInbox().then((messages) => {
          sendResponse(messages);
        });
      });
      return true; // async
    
    case "readMessage":
      ensureState().then(() => {
        readMessage(message.mid).then((msg) => {
          sendResponse(msg);
        });
      });
      return true; // async
    
    case "copyToClipboard":
      navigator.clipboard.writeText(message.text).then(() => {
        sendResponse({ success: true });
      });
      return true; // async
    
    case "deleteEmail":
      currentEmail = null;
      currentPassword = null;
      inboxMessages = [];
      stopInboxPolling();
      chrome.storage.local.remove([
        "currentEmail",
        "currentPassword",
        "inboxMessages",
      ]);
      sendResponse({ success: true });
      break;
    
    case "generatePassword":
      const length = message.length || 16;
      sendResponse({ password: generatePassword(length) });
      break;
    
    case "getOTP":
      ensureState().then(() => {
        let latestOTP = null;
        for (const msg of inboxMessages) {
          const text = msg.body || msg.subject || "";
          const otp = extractOTP(text);
          if (otp) {
            latestOTP = { code: otp, from: msg.from || msg.from_email || "", subject: msg.subject || "" };
            break;
          }
        }
        sendResponse(latestOTP);
      });
      return true; // async
  }
});

// ============================================================================
// Alarm for inbox polling (more reliable than setInterval in service workers)
// ============================================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "inboxPoll") {
    await ensureState();
    if (currentEmail) {
      await checkInbox();
    }
  }
});

// Keep service worker alive during async operations
chrome.runtime.onSuspend.addListener(() => {
  console.log("[TempMail] Service worker suspending");
});
