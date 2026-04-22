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
let gmailPayload = null;
let emailType = "other";
let emailTimestampRaw = null;
const MAX_CONSECUTIVE_FAILURES = 12;
// HTTP statuses that mean the email/session is definitively unusable. Hitting
// any of these from an inbox endpoint marks the email dead on the first
// occurrence instead of waiting for the transient-failure counter.
const DEAD_STATUSES = new Set([401, 403, 404, 410]);

// ============================================================================
// reCAPTCHA V3 Bypass (ported from freecaptcha Python library)
// ============================================================================

async function solveRecaptchaV3() {
  const anchorUrl = `https://www.google.com/recaptcha/api2/anchor?ar=1&k=${RECAPTCHA_SITE_KEY}&co=aHR0cHM6Ly9zbWFpbHByby5jb206NDQz&hl=en&v=abc123&size=invisible&cb=smailpro`;

  const anchorResp = await fetch(anchorUrl);
  const anchorHtml = await anchorResp.text();

  const tokenMatch = anchorHtml.match(/id="recaptcha-token"\s*value="(.*?)"/);
  if (!tokenMatch) {
    throw new Error("Failed to extract recaptcha-token from anchor");
  }

  const recapToken = tokenMatch[1];

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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const reloadText = await reloadResp.text();
  const jsonStr = reloadText.substring(5);
  const data = JSON.parse(jsonStr);
  return data[1];
}

// ============================================================================
// Gmail/Outlook Creation via smailpro.com
// ============================================================================

async function createGmailOrOutlook(type = "google") {
  let captchaToken;
  try {
    captchaToken = await solveRecaptchaV3();
  } catch (e) {
    console.error("[TempMail] Captcha solve failed:", e);
    return null;
  }

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
      "Referer": "https://smailpro.com/temporary-email",
    },
  });

  if (!resp.ok) {
    const error = await resp.json().catch(() => ({}));
    console.error("[TempMail] Create email failed:", error);
    return null;
  }

  const data = await resp.json();

  currentEmail = data.address;
  currentPassword = generatePassword();
  inboxMessages = [];
  emailCreatedAt = Date.now();
  consecutiveFailures = 0;
  isEmailDead = false;
  emailKey = data.key || null;
  emailType = type;

  // Clear all state first, then set new values
  await chrome.storage.local.clear();
  await chrome.storage.local.set({
    currentEmail: data.address,
    currentPassword: currentPassword,
    emailTimestamp: data.timestamp * 1000,
    emailTimestampRaw: data.timestamp,
    emailType: type,
    emailCreatedAt: Date.now(),
    isEmailDead: false,
    emailKey: emailKey,
    gmailPayload: gmailPayload,
  });

  // For Gmail/Outlook, kick off the first inbox check. refreshGmailPayloadAndCheck()
  // will seed cookies via a hidden tab if the service worker has no session yet.
  if (type === "google" || type === "microsoft") {
    setTimeout(async () => {
      try {
        await checkInbox();
      } catch (e) {
        console.warn("[TempMail] Initial Gmail inbox check failed:", e.message);
      }
    }, 500);
  }

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
    "emailTimestampRaw",
    "gmailPayload",
  ]);
  if (saved.currentEmail) {
    currentEmail = saved.currentEmail;
    currentPassword = saved.currentPassword || null;
    inboxMessages = saved.inboxMessages || [];
    emailCreatedAt = saved.emailCreatedAt || null;
    isEmailDead = saved.isEmailDead || false;
    emailKey = saved.emailKey || null;
    gmailPayload = saved.gmailPayload || null;
    emailType = saved.emailType || "other";
    emailTimestampRaw = saved.emailTimestampRaw || null;
    startInboxPolling();
  }
}

chrome.runtime.onInstalled.addListener(async () => {
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

chrome.runtime.onStartup.addListener(async () => {
  await restoreState();
});

async function ensureState() {
  if (!currentEmail) {
    await restoreState();
  }
}

// ============================================================================
// Gmail/Outlook Inbox API
// ============================================================================

// Opens a hidden tab to smailpro.com just long enough for the browser to
// store the session cookies returned by Set-Cookie. Used when the service
// worker's fetch has no valid session yet (first run, expired cookies).
// The old implementation also tried to read the payload through a content
// script listener that never existed — that message path has been dropped.
async function seedSmailproCookies() {
  try {
    const tab = await chrome.tabs.create({
      url: "https://smailpro.com/temporary-email",
      active: false,
    });
    await new Promise((r) => setTimeout(r, 2500));
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
  } catch (e) {
    console.warn("[TempMail] seedSmailproCookies error:", e.message);
  }
}

async function checkGmailOutlookInbox() {
  if (!currentEmail) return [];

  if (!emailKey) {
    return inboxMessages;
  }

  // The sonjj.com payload is a snapshot token tied to the timestamp it was
  // issued with — reusing the cached one never surfaces newly arrived messages.
  // Always refresh the payload via smailpro.com/app/inbox before each poll,
  // mirroring what the Temp Mail flow (getPayload + /inbox) does implicitly.
  try {
    return await refreshGmailPayloadAndCheck();
  } catch (e) {
    console.error("[TempMail] Gmail/Outlook inbox error:", e);
    await recordTransientFailure("network error");
    return inboxMessages;
  }
}

async function checkGmailInboxWithPayload(payload) {
  if (!payload) return [];

  const inboxUrl = `https://api.sonjj.com/v1/temp_gmail/inbox?payload=${encodeURIComponent(payload)}`;

  try {
    const response = await fetch(inboxUrl, {
      headers: { "Accept": "application/json" },
    });

    if (!response.ok) {
      if (DEAD_STATUSES.has(response.status)) {
        await markEmailDead(`inbox ${response.status}`);
        return [];
      }
      await recordTransientFailure(`inbox ${response.status}`);
      return [];
    }

    const data = await response.json();

    if (!data || !data.messages) {
      return [];
    }

    consecutiveFailures = 0;

    const existingMids = new Set(inboxMessages.map((m) => m.mid));
    let newMessages = [];

    for (const msg of data.messages) {
      if (!existingMids.has(msg.mid)) {
        const normalized = await normalizeGmailMessage(msg);
        newMessages.push(normalized);
        inboxMessages.unshift(normalized);
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
    console.error("[TempMail] checkGmailInboxWithPayload error:", e);
    await recordTransientFailure("network error");
    return [];
  }
}

async function refreshGmailPayloadAndCheck() {
  let inboxResp;
  try {
    inboxResp = await fetch("https://smailpro.com/app/inbox", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Referer": "https://smailpro.com/temporary-email",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify([{
        address: currentEmail,
        timestamp: emailTimestampRaw || Math.floor(Date.now() / 1000),
        key: emailKey,
      }]),
    });
  } catch (e) {
    console.warn("[TempMail] smailpro.com/app/inbox network error:", e.message);
    await recordTransientFailure("network error");
    return inboxMessages;
  }

  if (!inboxResp.ok) {
    console.warn(`[TempMail] smailpro.com/app/inbox ${inboxResp.status} — session cookies may be missing; re-seeding via hidden tab`);
    // Cookies may be missing/expired. Seed them with a hidden tab and retry once.
    await seedSmailproCookies();
    try {
      inboxResp = await fetch("https://smailpro.com/app/inbox", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Referer": "https://smailpro.com/temporary-email",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify([{
          address: currentEmail,
          timestamp: emailTimestampRaw || Math.floor(Date.now() / 1000),
          key: emailKey,
        }]),
      });
    } catch (e) {
      console.warn("[TempMail] retry after seed failed:", e.message);
    }
  }

  if (!inboxResp || !inboxResp.ok) {
    // Dead signals on smailpro.com mean the key itself is no longer valid —
    // cookies were already re-seeded above, so this isn't a session problem.
    if (inboxResp && DEAD_STATUSES.has(inboxResp.status)) {
      await markEmailDead(`smailpro ${inboxResp.status}`);
      return inboxMessages;
    }
    await recordTransientFailure(`smailpro ${inboxResp ? inboxResp.status : "net"}`);
    return inboxMessages;
  }

  let inboxData;
  try {
    inboxData = await inboxResp.json();
  } catch (e) {
    console.warn("[TempMail] smailpro.com/app/inbox returned non-JSON");
    await recordTransientFailure("non-JSON response");
    return inboxMessages;
  }

  const freshPayload = inboxData && inboxData[0] && inboxData[0].payload;
  if (!freshPayload) {
    console.warn("[TempMail] smailpro.com/app/inbox returned no payload", inboxData);
    await recordTransientFailure("no payload in response");
    return inboxMessages;
  }

  gmailPayload = freshPayload;
  await chrome.storage.local.set({ gmailPayload });

  await checkGmailInboxWithPayload(freshPayload);
  return inboxMessages;
}

// ============================================================================
// SmailPro API (Temp Mail)
// ============================================================================

async function getPayload(url, email = null, mid = null) {
  const params = new URLSearchParams({ url });
  if (email) params.set("email", email);
  if (mid) params.set("mid", mid);

  const targetUrl = `${PAYLOAD_URL}?${params.toString()}`;

  try {
    const response = await fetch(targetUrl);

    if (response.status === 429) {
      console.warn("[TempMail] Rate limited");
      return null;
    }
    if (!response.ok) {
      console.warn(`[TempMail] Payload failed: ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (e) {
    console.error("[TempMail] Payload fetch error:", e.message);
    return null;
  }
}

async function apiRequest(endpoint, params = {}) {
  const url = new URL(`${BASE_API_URL}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  try {
    const response = await fetch(url.toString());

    if (!response.ok) {
      console.warn(`[TempMail] API failed: ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (e) {
    console.error("[TempMail] API fetch error:", e.message);
    return null;
  }
}

async function createEmail(customName = null) {
  try {
    const payload = await getPayload(`${BASE_API_URL}/create`, customName);
    if (!payload) return null;

    const params = { payload };
    if (customName) params.email = customName;

    const data = await apiRequest("/create", params);
    if (!data || !data.email) return null;

    currentEmail = data.email;
    currentPassword = generatePassword();
    inboxMessages = [];
    emailCreatedAt = Date.now();
    consecutiveFailures = 0;
    isEmailDead = false;
    emailType = "other";
    emailKey = null;
    emailTimestampRaw = data.timestamp || null;

    await chrome.storage.local.set({
      currentEmail: data.email,
      currentPassword: currentPassword,
      emailTimestamp: data.timestamp || Date.now(),
      emailTimestampRaw: data.timestamp || null,
      emailCreatedAt: Date.now(),
      isEmailDead: false,
      emailType: "other",
      emailKey: null,
    });

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
    await recordTransientFailure("payload unavailable");
    return inboxMessages;
  }

  // Inline fetch so we can see the status code — a 404/410 from the inbox
  // endpoint means the temp mailbox has been recycled/expired on the server.
  let inboxResp;
  try {
    const url = `${BASE_API_URL}/inbox?payload=${encodeURIComponent(payload)}`;
    inboxResp = await fetch(url);
  } catch (e) {
    console.error("[TempMail] inbox fetch error:", e.message);
    await recordTransientFailure("network error");
    return inboxMessages;
  }

  if (!inboxResp.ok) {
    if (DEAD_STATUSES.has(inboxResp.status)) {
      await markEmailDead(`inbox ${inboxResp.status}`);
      return inboxMessages;
    }
    await recordTransientFailure(`inbox ${inboxResp.status}`);
    return inboxMessages;
  }

  let data;
  try {
    data = await inboxResp.json();
  } catch (e) {
    await recordTransientFailure("non-JSON response");
    return inboxMessages;
  }

  if (!data || !data.messages) {
    await recordTransientFailure("no messages field");
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
}

async function readMessage(mid) {
  if (!currentEmail) return null;

  if (emailType === "google" || emailType === "microsoft") {
    return await readGmailOutlookMessage(mid);
  }

  const cached = inboxMessages.find((m) => m.mid === mid);
  if (cached && cached.body) return cached;

  const payload = await getPayload(`${BASE_API_URL}/message`, currentEmail, mid);
  if (!payload) return null;

  const data = await apiRequest("/message", { payload });
  if (!data) return null;

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
}

async function refreshGmailPayload() {
  const doFetch = () => fetch("https://smailpro.com/app/inbox", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "Referer": "https://smailpro.com/temporary-email",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify([{
      address: currentEmail,
      timestamp: emailTimestampRaw || Math.floor(Date.now() / 1000),
      key: emailKey,
    }]),
  });

  try {
    let inboxResp = await doFetch();
    if (!inboxResp.ok) {
      await seedSmailproCookies();
      inboxResp = await doFetch();
    }
    if (inboxResp.ok) {
      const inboxData = await inboxResp.json();
      if (inboxData && inboxData[0] && inboxData[0].payload) {
        gmailPayload = inboxData[0].payload;
        await chrome.storage.local.set({ gmailPayload });
        return gmailPayload;
      }
    }
  } catch (e) {
    console.warn("[TempMail] refreshGmailPayload error:", e.message);
  }
  return null;
}

async function normalizeGmailMessage(msg) {
  if (!msg) return msg;
  return {
    ...msg,
    from: msg.from || msg.from_email || msg.textFrom || "Unknown",
    from_email: msg.from_email || msg.textFrom || "",
    subject: msg.subject || msg.textSubject || "No subject",
    date: msg.date || msg.timestamp || msg.textDate || "",
    body: msg.body || msg.body_html || "",
    body_html: msg.body_html || msg.body || "",
  };
}

async function readGmailOutlookMessage(mid) {
  if (!currentEmail) return null;

  const cached = inboxMessages.find((m) => m.mid === mid);
  if (cached && (cached.body || cached.body_html)) return cached;

  if (emailKey) {
    const messageData = await readGmailOutlookMessageViaJWT(mid);
    if (messageData) return messageData;
  }

  return null;
}

async function readGmailOutlookMessageViaJWT(mid) {
  if (!emailKey) return null;

  let payload = gmailPayload || emailKey;

  try {
    const messageUrl = `https://api.sonjj.com/v1/temp_gmail/message?payload=${encodeURIComponent(payload)}&mid=${encodeURIComponent(mid)}`;

    let response = await fetch(messageUrl, {
      headers: { "Accept": "application/json" },
    });

    if (response.status === 401 && gmailPayload) {
      const freshPayload = await refreshGmailPayload();
      if (freshPayload) {
        payload = freshPayload;
        const retryUrl = `https://api.sonjj.com/v1/temp_gmail/message?payload=${encodeURIComponent(payload)}&mid=${encodeURIComponent(mid)}`;
        response = await fetch(retryUrl, {
          headers: { "Accept": "application/json" },
        });
      }
    }

    if (!response.ok) return null;

    const data = await response.json();

    if (!data || Object.keys(data).length === 0) return null;

    const normalizedData = await normalizeGmailMessage(data);

    const idx = inboxMessages.findIndex((m) => m.mid === mid);
    if (idx >= 0) {
      inboxMessages[idx] = { ...inboxMessages[idx], ...normalizedData };
    } else {
      inboxMessages.unshift(normalizedData);
    }

    await chrome.storage.local.set({ inboxMessages });

    checkForOTP([normalizedData]);
    checkForVerificationLinks([normalizedData]);

    return normalizedData;
  } catch (e) {
    console.error("[TempMail] readGmailOutlookMessageViaJWT error:", e);
    return null;
  }
}

// ============================================================================
// Email Dead Detection
// ============================================================================

function notifyEmailDead(reason) {
  chrome.runtime.sendMessage({
    action: "emailDead",
    reason: reason || null,
  }).catch(() => {});
}

async function markEmailDead(reason) {
  if (isEmailDead) return;
  isEmailDead = true;
  consecutiveFailures = 0;
  await chrome.storage.local.set({ isEmailDead: true });
  stopInboxPolling();
  notifyEmailDead(reason);

  try {
    const { showNotification } = await chrome.storage.local.get(["showNotification"]);
    if (showNotification !== false) {
      chrome.notifications.create(`tempmail-dead-${Date.now()}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Temp Email expired",
        message: `${currentEmail || "Your email"} can no longer receive messages${reason ? ` (${reason})` : ""}. Create a new one.`,
        priority: 2,
      });
    }
  } catch (e) {}
}

async function recordTransientFailure(reason) {
  consecutiveFailures++;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !isEmailDead) {
    await markEmailDead(reason || "repeated failures");
  }
}

// ============================================================================
// OTP Detection
// ============================================================================

function extractOTP(text) {
  if (!text) return null;

  const plainText = text.replace(/<[^>]+>/g, " ");

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
    const text = msg.body || msg.body_html || msg.textContent || msg.textBody || msg.subject || msg.textSubject || "";
    const otp = extractOTP(text);

    if (otp) {
      if (settings.showNotification) {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "TempMail AutoFill",
          message: `Verification code detected: ${otp}`,
          priority: 2,
        });
      }

      chrome.runtime.sendMessage({
        action: "otpDetected",
        code: otp,
        from: msg.from || msg.from_email || msg.textFrom || "",
        subject: msg.subject || msg.textSubject || "",
      }).catch(() => {});
    }
  }
}

// ============================================================================
// Verification Link Detection
// ============================================================================

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

async function checkForVerificationLinks(messages) {
  for (const msg of messages) {
    const body = msg.body || msg.body_html || msg.textContent || msg.textBody || "";
    const links = extractVerificationLinks(body);

    if (links.length > 0) {
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

      chrome.runtime.sendMessage({
        action: "verificationLinkDetected",
        links: links,
        from: msg.from || msg.from_email || msg.textFrom || "",
        subject: msg.subject || msg.textSubject || "",
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
  chrome.alarms.create("inboxPoll", { periodInMinutes: 0.083 });
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
        if (result) {
          result.messages = inboxMessages;
          result.isDead = isEmailDead;
        }
        sendResponse(result);
      });
      return true;

    case "createGmail":
      createGmailOrOutlook("google").then((result) => {
        if (result) {
          result.messages = inboxMessages;
          result.isDead = isEmailDead;
        }
        sendResponse(result);
      });
      return true;

    case "createOutlook":
      createGmailOrOutlook("microsoft").then((result) => {
        if (result) {
          result.messages = inboxMessages;
          result.isDead = isEmailDead;
        }
        sendResponse(result);
      });
      return true;

    case "getEmail":
      ensureState().then(() => {
        sendResponse({
          email: currentEmail,
          password: currentPassword,
          messages: inboxMessages,
          isDead: isEmailDead,
        });
      });
      return true;

    case "checkInbox":
      ensureState().then(() => {
        checkInbox().then((messages) => {
          sendResponse(messages);
        });
      });
      return true;

    case "readMessage":
      ensureState().then(() => {
        readMessage(message.mid).then((msg) => {
          sendResponse(msg);
        });
      });
      return true;

    case "copyToClipboard":
      navigator.clipboard.writeText(message.text).then(() => {
        sendResponse({ success: true });
      });
      return true;

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
      sendResponse({ password: generatePassword(message.length || 16) });
      break;

    case "getOTP":
      ensureState().then(() => {
        let latestOTP = null;
        for (const msg of inboxMessages) {
          const text = msg.body || msg.body_html || msg.textContent || msg.textBody || msg.subject || msg.textSubject || "";
          const otp = extractOTP(text);
          if (otp) {
            latestOTP = { code: otp, from: msg.from || msg.from_email || msg.textFrom || "", subject: msg.subject || msg.textSubject || "" };
            break;
          }
        }
        sendResponse(latestOTP);
      });
      return true;
  }
});

// ============================================================================
// Alarm for inbox polling
// ============================================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "inboxPoll") {
    await ensureState();
    if (currentEmail) {
      await checkInbox();
    }
  }
});