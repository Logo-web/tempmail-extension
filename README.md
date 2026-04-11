# TempMail AutoFill

Chrome Extension that auto-fills temporary emails and detects OTP verification codes.

## Features

- **Auto-fill email & password** on registration forms using native browser datalist dropdown
- **OTP Detection** - Automatically detects verification codes in incoming emails and fills them into input fields
- **Multiple Email Types**:
  - Temporary emails (free domains)
  - Gmail (@gmail.com)
  - Outlook (@outlook.com)
- **Email Monitoring** - Real-time inbox monitoring with notifications
- **Dark Mode** - Full dark mode support

## Installation

1. Clone the repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" and select the `tempmail-extension` folder
5. Click the extension icon to create a new email

## Usage

1. Click the extension icon in your browser toolbar
2. Select email type (Temp Mail, Gmail, or Outlook)
3. Click "Create Email" to generate a new email address
4. The email will be available in the datalist dropdown on any registration form
5. Incoming emails appear in the extension popup
6. OTP codes are automatically detected and can be filled with one click

## Permissions

- `storage` - Save email state
- `alarms` - Poll inbox periodically
- `tabs` - Communicate with content scripts
- Host permissions for smailpro.com API

## Tech Stack

- Manifest V3
- Vanilla JavaScript
- reCAPTCHA v3 bypass for Gmail/Outlook creation
