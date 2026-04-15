# TempMail AutoFill — Context for AI Coding Agents

## What This Project Is

A **Chrome Extension (Manifest V3)** that:
1. Detects registration/signup forms on any website
2. Suggests using a temporary email via native browser datalist dropdown
3. Auto-fills email + generated password into forms
4. Auto-detects OTP/verification codes in incoming emails and fills them into fields
5. Detects verification links in emails and offers to open them
6. Supports three email types: **Temp Mail** (free domains via sonjj.com API), **Gmail** (@gmail.com), **Outlook** (@outlook.com)
7. Uses **smailpro.com's API** (reverse-engineered, no official API key needed)

---

## Architecture Overview

```
tempmail-extension/
├── manifest.json          MV3 manifest (permissions: storage, alarms, notifications, tabs)
├── background.js          Service worker — all API calls, inbox polling, OTP detection, state management
├── content.js             Content script — form detection, datalist injection, UI widgets, OTP/verify overlay
├── content.css            Styles for content-script widgets (badge, prompt, OTP, verification widget)
├── popup.html/js/css      Extension popup — email creation, inbox display, OTP display, message viewer
├── options.html/js/css    Settings page — toggle auto-fill, OTP, notifications, poll interval
└── icons/                 Extension icons (16, 48, 128)
```

### Communication Flow

- **popup.js ↔ background.js**: `chrome.runtime.sendMessage` for all actions (createEmail, createGmail, createOutlook, checkInbox, readMessage, getOTP, etc.)
- **background.js → content.js**: `chrome.tabs.sendMessage` for `emailCreated`, `otpDetected`, `verificationLinkDetected`, `fetchGmailPayload`
- **content.js → background.js**: `chrome.runtime.sendMessage` (not currently used for any actions, but the listener exists)
- **State persistence**: `chrome.storage.local` — survives service worker restarts. Content script listens to `chrome.storage.onChanged` to update UI without page reload.
- **content.js also listens** to `chrome.runtime.onMessage` for direct messages from background.

---

## API Details (Critical)

### Temp Mail (domains like @tmpmail.net, etc.)

- **Create email**: `POST https://api.sonjj.com/v1/temp_email/create?payload=<payload>` where payload comes from `https://smailpro.com/app/payload?url=<encoded_url>`
- **Inbox**: `GET https://api.sonjj.com/v1/temp_email/inbox?payload=<payload>` — payload is per-email, fetched fresh via `smailpro.com/app/payload?url=...&email=...`
- **Read message**: `GET https://api.sonjj.com/v1/temp_email/message?payload=<payload>&mid=<mid>`
- **Key trait**: `api.sonjj.com` returns `access-control-allow-origin: *` — **NEVER use `credentials: "include"`** on these requests or you get `TypeError: Failed to fetch` due to CORS.

### Gmail/Outlook (via smailpro.com)

- **Create**: `GET https://smailpro.com/app/create?username=random&type=alias&domain=<gmail.com|outlook.com>&server=1` with `x-captcha` header containing reCAPTCHA v3 token
- **reCAPTCHA bypass**: `solveRecaptchaV3()` in background.js — ports the Python `freecaptcha` library. Fetches anchor token from `google.com/recaptcha/api2/anchor`, then exchanges via `/api2/reload` to get a valid v3 token.
- **Inbox (two-step)**:
  1. `POST https://smailpro.com/app/inbox` with body `[{"address":"email","timestamp":ts,"key":"jwt_key"}]` and `credentials: "include"` → returns a **fresh payload**
  2. `GET https://api.sonjj.com/v1/temp_gmail/inbox?payload=<fresh_payload>` → returns messages
- **Message field names differ** from temp mail. Gmail messages use: `textFrom` (not `from`), `textSubject` (not `subject`), `textDate` (not `date`), `body` contains HTML directly.

### Payload Lifecycle for Gmail/Outlook

1. On create, `createGmailOrOutlook()` saves `emailKey` and `emailTimestampRaw`
2. `fetchGmailPayloadFromSmailpro()` opens a **hidden tab** to `smailpro.com/temporary-email`, sends `fetchGmailPayload` message to content script running on that page. The content script runs `fetchGmailPayloadFromPage()` which can use `credentials: "include"` since it's in the page context.
3. The payload is stored in `gmailPayload` (memory + storage) and used for subsequent `checkGmailInboxWithPayload()` calls.
4. **Payloads expire** — on 401 response, `refreshGmailPayload()` is called (also uses `credentials: "include"` directly from service worker — this is a known potential issue, see below).

### Key CORS Constraint

- `api.sonjj.com` responses include `access-control-allow-origin: *`
- When `access-control-allow-origin: *` is present, **`credentials: "include"` is not allowed** by the browser
- This caused hard-to-debug `TypeError: Failed to fetch` errors
- **Rule**: All requests to `api.sonjj.com` must use **no credentials**. Only `smailpro.com` requests use `credentials: "include"`.

---

## Gmail/Outlook Field Normalization

`normalizeGmailMessage(msg)` in background.js maps:
```
from ← msg.from || msg.from_email || msg.textFrom || "Unknown"
from_email ← msg.from_email || msg.textFrom || ""
subject ← msg.subject || msg.textSubject || "No subject"
date ← msg.date || msg.timestamp || msg.textDate || ""
body ← msg.body || msg.body_html || ""
body_html ← msg.body_html || msg.body || ""
```

All code paths (background, content, popup) use **field fallbacks** like `msg.from || msg.from_email || msg.textFrom` to handle both temp mail and Gmail/Outlook message formats.

---

## State Variables (background.js)

| Variable | Type | Description |
|---|---|---|
| `currentEmail` | string\|null | Current active email address |
| `currentPassword` | string\|null | Generated password for the email |
| `inboxMessages` | array | Cached inbox messages |
| `isPolling` | boolean | Whether inbox polling alarm is active |
| `emailCreatedAt` | number\|null | Timestamp when email was created |
| `consecutiveFailures` | number | Consecutive failed inbox checks |
| `isEmailDead` | boolean | Email marked as expired after MAX_CONSECUTIVE_FAILURES (100) |
| `emailKey` | string\|null | JWT key from Gmail/Outlook creation response |
| `gmailPayload` | string\|null | Fresh payload for Gmail/Outlook inbox API |
| `emailType` | "google"\|"microsoft"\|"other" | Type of current email |
| `emailTimestampRaw` | number\|null | Raw timestamp from smailpro creation response |

All state is persisted in `chrome.storage.local` and restored via `restoreState()` on service worker startup/extension install.

---

## Key Functions

### background.js (968 lines)

- **`solveRecaptchaV3()`** — Bypasses reCAPTCHA v3 to get token for Gmail/Outlook creation
- **`createGmailOrOutlook(type)`** — Creates Gmail/Outlook email, clears storage, saves state, starts polling, notifies all tabs
- **`createEmail(customName)`** — Creates Temp Mail email
- **`checkInbox()`** — Routes to `checkGmailOutlookInbox()` or temp mail inbox based on `emailType`
- **`checkGmailOutlookInbox()`** → `checkGmailInboxWithPayload(payload)` — Checks Gmail/Outlook inbox
- **`fetchGmailPayloadFromSmailpro()`** — Opens hidden tab to smailpro, sends message to content script to fetch payload with cookies
- **`refreshGmailPayload()`** — Direct `POST smailpro.com/app/inbox` with `credentials: "include"` (potential CORS issue from service worker)
- **`readMessage(mid)`** / **`readGmailOutlookMessage(mid)`** — Reads full message body
- **`normalizeGmailMessage(msg)`** — Normalizes Gmail/Outlook fields to standard format
- **`extractOTP(text)`** — Regex-based OTP extraction from email body
- **`checkForOTP(messages)`** — Scans new messages for OTP codes, sends `otpDetected` message
- **`extractVerificationLinks(text)`** / **`checkForVerificationLinks(messages)`** — Detects verification URLs in email bodies
- **`generatePassword(length)`** — Generates secure random password with guaranteed character classes
- **`startInboxPolling()`** — Creates `chrome.alarms` alarm at ~5 second intervals

### content.js (961 lines)

- **Form detection**: `EMAIL_FIELD_SELECTORS`, `PASSWORD_FIELD_SELECTORS`, `OTP_FIELD_SELECTORS`, `FORM_INDICATORS`, `PAGE_INDICATORS`
- **`updateDatalists()`** — Creates/updates `<datalist>` elements for email and password autocomplete
- **`attachEmailDatalist(force)`** / **`attachPasswordDatalist(force)`** — Binds datalists to discovered form fields
- **`addTempmailIndicator(field)`** / **`addPasswordIndicator(field)`** — Wraps fields, adds clickable badge overlay
- **`createPromptWidget(...)`** — "Use temporary email?" floating widget
- **`createOTPWidget(code, from, subject)`** — OTP auto-fill widget
- **`createVerificationLinkWidget(links, from, subject)`** — Verification link detection widget
- **`fetchGmailPayloadFromPage(email, timestamp, key)`** — Runs inside smailpro.com page context, uses `credentials: "include"` to fetch Gmail payload
- **`chrome.storage.onChanged` listener** — Updates datalists and widgets when email/password/messages change in storage (survives service worker restarts)
- **`MutationObserver`** — Watches DOM changes, triggers `scanForForms()` on added nodes
- **`setInterval(scanForForms, 2000)`** — Periodic form scan

### popup.js (352 lines)

- Standard popup UI: email display, password display, copy buttons, type selector (Temp Mail/Gmail/Outlook), inbox list, message modal, OTP section
- **`openMessage(msg)`** — Fetches full message body and renders in modal; links open in new tabs via `chrome.tabs.create`
- Field fallbacks: `msg.from || msg.from_email || msg.textFrom`, `msg.subject || msg.textSubject`, etc.

---

## Known Issues / Untested

### 1. `refreshGmailPayloadAndCheck()` CORS issue (background.js:345-381)
This function does `POST https://smailpro.com/app/inbox` with `credentials: "include"` directly from the service worker. This **may not work** because service workers don't have smailpro.com cookies. The primary path (`checkGmailInboxWithPayload` with stored payload) works. If no stored payload exists, it falls back to `refreshGmailPayloadAndCheck()` which likely fails silently, and then `fetchGmailPayloadFromSmailpro()` (hidden tab method) should be used instead.

**Fix needed**: When `refreshGmailPayloadAndCheck()` fails, fall back to `fetchGmailPayloadFromSmailpro()` instead of just returning `inboxMessages`.

### 2. OTP auto-fill end-to-end (content.js)
The OTP detection and widget display code paths are implemented but **not tested end-to-end** with real Gmail messages. Specifically:
- `checkForOTP()` in background detects OTP from messages and sends `otpDetected` message
- Content script receives it and shows the widget
- `chrome.storage.onChanged` also detects new messages and tries to extract OTP
- Both paths have field fallbacks for Gmail fields

### 3. Verification link detection end-to-end
Similar to OTP — code paths exist but **not tested** with real Gmail/Outlook messages.

### 4. New Gmail/Outlook creation from scratch
Creating an existing Gmail works. Creating a **new** Gmail/Outlook from scratch hasn't been tested recently. The `solveRecaptchaV3()` function could break if Google changes their reCAPTCHA endpoint.

### 5. Service worker lifecycle
Service workers get killed after ~30 seconds of inactivity. State is persisted in `chrome.storage.local` and restored via `restoreState()`. The `chrome.alarms` API handles periodic inbox polling. The content script's `chrome.storage.onChanged` listener ensures datalists and widgets update even after service worker restarts.

---

## Design Decisions

- **Datalist over custom dropdown**: Uses native HTML `<datalist>` for email/password suggestions — feels like Chrome's native autofill, minimal CSS needed
- **Separate email and password datalists**: `tempmail-autocomplete-list` and `tempmail-autocomplete-list-pw`
- **Badge overlays**: Small circular icons (mail/password SVG) positioned over form fields — clicking fills the value
- **Widget-based prompts**: "Use temporary email?", OTP code, and verification link widgets appear as overlays in the bottom-right corner
- **No custom widget for form detection**: Content script just attaches datalists and badges — the browser's native autocomplete UI handles the rest
- **Storage-based sync**: Content script monitors `chrome.storage.onChanged` instead of relying on persistent `chrome.runtime.sendMessage` connections, which break when service workers restart

---

## File Sizes (post-cleanup)

| File | Lines | Description |
|---|---|---|
| background.js | 968 | Service worker — all API logic, state, polling, message handlers |
| content.js | 961 | Form detection, datalists, badges, widgets, storage listener |
| content.css | 549 | Styles for badges, prompt widget, OTP widget, verification widget |
| popup.js | 352 | Popup logic — email creation, inbox display, message reading |
| popup.html | 157 | Popup HTML structure |
| popup.css | 647 | Popup styles including dark mode |
| options.js | 61 | Settings page logic |
| options.html | 133 | Settings page HTML |
| options.css | 246 | Settings page styles |
| manifest.json | 47 | MV3 manifest |

---

## How to Build / Run

1. Open `chrome://extensions/` in Chrome
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `tempmail-extension/` directory
4. The extension icon appears in the toolbar — click to open popup
5. Navigate to any signup page — the content script detects forms and injects datalists/badges

No build step, no bundler, no npm — plain JavaScript files loaded directly by Chrome.

---

## Chrome Storage Keys

| Key | Type | Default | Description |
|---|---|---|---|
| `currentEmail` | string | — | Active email address |
| `currentPassword` | string | — | Generated password |
| `inboxMessages` | array | [] | Cached inbox messages |
| `emailCreatedAt` | number | — | Timestamp of email creation |
| `emailTimestamp` | number | — | Adjusted timestamp (ms) |
| `emailTimestampRaw` | number | — | Raw timestamp from smailpro |
| `emailType` | string | "other" | "google", "microsoft", or "other" |
| `emailKey` | string | — | JWT key for Gmail/Outlook |
| `gmailPayload` | string | — | Fresh payload for Gmail/Outlook inbox |
| `isEmailDead` | boolean | false | Email marked expired |
| `autoFillEnabled` | boolean | true | Auto-detect registration forms |
| `autoGeneratePassword` | boolean | true | Auto-generate password |
| `passwordLength` | number | 16 | Password length |
| `autoCheckInbox` | boolean | true | Auto-poll inbox |
| `inboxPollInterval` | number | 5000 | Poll interval in ms |
| `showNotification` | boolean | true | Desktop notifications |
| `otpAutoFill` | boolean | true | Auto-detect and fill OTP |
| `otpAutoSubmit` | boolean | false | Auto-submit after OTP fill |

---

## Message Protocol (background ↔ popup/content)

### popup.js → background.js
| Action | Payload | Response |
|---|---|---|
| `createEmail` | `{ customName? }` | `{ email, password, messages, isDead }` |
| `createGmail` | — | `{ email, password, type, messages, isDead }` |
| `createOutlook` | — | `{ email, password, type, messages, isDead }` |
| `getEmail` | — | `{ email, password, messages, isDead }` |
| `checkInbox` | — | `messages[]` |
| `readMessage` | `{ mid }` | message object |
| `getOTP` | — | `{ code, from, subject }` or null |
| `copyToClipboard` | `{ text }` | `{ success: true }` |
| `deleteEmail` | — | `{ success: true }` |
| `generatePassword` | `{ length? }` | `{ password }` |

### background.js → content.js / popup.js
| Action | Payload |
|---|---|
| `emailCreated` | `{ email, password }` |
| `newMessages` | `{ messages, count }` |
| `otpDetected` | `{ code, from, subject }` |
| `verificationLinkDetected` | `{ links, from, subject }` |
| `emailDead` | — |

### background.js → content.js (on smailpro tab)
| Action | Payload | Response |
|---|---|---|
| `fetchGmailPayload` | `{ email, timestamp, key }` | `{ payload }` or `{ error }` |

---

## Potential Next Steps

1. **Fix `refreshGmailPayloadAndCheck()` fallback** — When direct `POST smailpro.com/app/inbox` fails from service worker (no cookies), fall back to `fetchGmailPayloadFromSmailpro()` (hidden tab method)
2. **Test OTP auto-fill end-to-end** with real Gmail/Outlook messages
3. **Test verification link detection** end-to-end
4. **Test new Gmail/Outlook creation** from scratch (reCAPTCHA bypass may need updating)
5. **Add auto-submit for OTP** — Settings UI has the toggle (`otpAutoSubmit`) but the content script doesn't implement auto-submit yet (it only submits if user clicks "Auto-fill code" button)
6. **Improve form detection** — `isRegistrationForm()` is currently broad (checks full page body text) which could cause false positives
7. **Rate limiting / error handling** — API rate limits (429) are handled for payload but not for all endpoints