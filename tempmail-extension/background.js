// ============================================================================
// TempMail AutoFill - Background Service Worker
// ============================================================================

const BASE_API_URL = "https://api.sonjj.com/v1/temp_email";
const PAYLOAD_URL = "https://smailpro.com/app/payload";

// State
let currentEmail = null;
let currentPassword = null;
let inboxMessages = [];
let isPolling = false;

// ============================================================================
// Initialization
// ============================================================================

async function restoreState() {
  const saved = await chrome.storage.local.get([
    "currentEmail",
    "currentPassword",
    "inboxMessages",
  ]);
  if (saved.currentEmail) {
    currentEmail = saved.currentEmail;
    currentPassword = saved.currentPassword || null;
    inboxMessages = saved.inboxMessages || [];
    console.log("[TempMail] Restored state:", currentEmail);
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

    console.log("[TempMail] New email created:", currentEmail);

    await chrome.storage.local.set({
      currentEmail: data.email,
      currentPassword: currentPassword,
      emailTimestamp: data.timestamp || Date.now(),
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

// ============================================================================
// Gmail/Outlook Creation via smailpro.com page
// ============================================================================

async function createGmailEmail() {
  console.log("[TempMail] Creating Gmail via smailpro.com...");
  
  // Open smailpro in a new tab
  const tab = await chrome.tabs.create({
    url: "https://smailpro.com/temporary-email",
    active: true,
  });
  
  console.log("[TempMail] Opened smailpro tab:", tab.id);
  
  // Store a promise that resolves when the email is created
  return new Promise((resolve) => {
    // Listen for the email created message from the content script
    const listener = (message, sender, sendResponse) => {
      if (message.action === "gmailCreated" && sender.tab && sender.tab.id === tab.id) {
        chrome.runtime.onMessage.removeListener(listener);
        
        currentEmail = message.email;
        currentPassword = null; // Gmail doesn't need a password from us
        inboxMessages = [];
        
        chrome.storage.local.set({
          currentEmail: message.email,
          currentPassword: null,
          emailTimestamp: Date.now(),
          emailType: "gmail",
        });
        
        // Notify all tabs
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach((t) => {
            chrome.tabs.sendMessage(t.id, {
              action: "emailCreated",
              email: currentEmail,
              password: currentPassword,
            }).catch(() => {});
          });
        });
        
        chrome.runtime.sendMessage({
          action: "emailCreated",
          email: currentEmail,
          password: currentPassword,
        }).catch(() => {});
        
        startInboxPolling();
        
        // Close the smailpro tab after a short delay
        setTimeout(() => {
          chrome.tabs.remove(tab.id).catch(() => {});
        }, 1000);
        
        resolve({ email: currentEmail, password: currentPassword });
      }
    };
    
    chrome.runtime.onMessage.addListener(listener);
    
    // Timeout after 30 seconds
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      chrome.tabs.remove(tab.id).catch(() => {});
      resolve(null);
    }, 30000);
  });
}

async function createOutlookEmail() {
  console.log("[TempMail] Creating Outlook via smailpro.com...");
  
  const tab = await chrome.tabs.create({
    url: "https://smailpro.com/temporary-email",
    active: true,
  });
  
  console.log("[TempMail] Opened smailpro tab:", tab.id);
  
  return new Promise((resolve) => {
    const listener = (message, sender, sendResponse) => {
      if (message.action === "outlookCreated" && sender.tab && sender.tab.id === tab.id) {
        chrome.runtime.onMessage.removeListener(listener);
        
        currentEmail = message.email;
        currentPassword = null;
        inboxMessages = [];
        
        chrome.storage.local.set({
          currentEmail: message.email,
          currentPassword: null,
          emailTimestamp: Date.now(),
          emailType: "outlook",
        });
        
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach((t) => {
            chrome.tabs.sendMessage(t.id, {
              action: "emailCreated",
              email: currentEmail,
              password: currentPassword,
            }).catch(() => {});
          });
        });
        
        chrome.runtime.sendMessage({
          action: "emailCreated",
          email: currentEmail,
          password: currentPassword,
        }).catch(() => {});
        
        startInboxPolling();
        
        setTimeout(() => {
          chrome.tabs.remove(tab.id).catch(() => {});
        }, 1000);
        
        resolve({ email: currentEmail, password: currentPassword });
      }
    };
    
    chrome.runtime.onMessage.addListener(listener);
    
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      chrome.tabs.remove(tab.id).catch(() => {});
      resolve(null);
    }, 30000);
  });
}

async function checkInbox() {
  if (!currentEmail) return [];
  
  const payload = await getPayload(`${BASE_API_URL}/inbox`, currentEmail);
  if (!payload) return inboxMessages;
  
  const data = await apiRequest("/inbox", { payload });
  if (!data || !data.messages) return inboxMessages;
  
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
      createGmailEmail().then((result) => {
        sendResponse(result);
      });
      return true; // async

    case "createOutlook":
      createOutlookEmail().then((result) => {
        sendResponse(result);
      });
      return true; // async
    
    case "getEmail":
      ensureState().then(() => {
        sendResponse({
          email: currentEmail,
          password: currentPassword,
          messages: inboxMessages,
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
