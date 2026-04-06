#!/usr/bin/env python3
"""
SmailPro Wrapper - Unofficial API wrapper for smailpro.com temporary email service.

This script reverse-engineers the smailpro.com website to provide:
- Create temporary email addresses
- Poll inbox for new messages
- Read email message content
- Auto-refresh inbox monitoring

Usage:
    python smailpro_wrapper.py create          # Create new email
    python smailpro_wrapper.py inbox           # Check inbox
    python smailpro_wrapper.py read <mid>      # Read specific message
    python smailpro_wrapper.py monitor         # Auto-refresh inbox every 10s
    python smailpro_wrapper.py create --email myname  # Create with custom name
"""

import requests
import json
import time
import sys
import os
from datetime import datetime
from typing import Optional, Dict, List, Any
from dataclasses import dataclass, field
from pathlib import Path


# ============================================================================
# Configuration
# ============================================================================

BASE_API_URL = "https://api.sonjj.com/v1/temp_email"
PAYLOAD_URL = "https://smailpro.com/app/payload"
STATE_FILE = Path(__file__).parent / ".smailpro_state.json"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://smailpro.com/",
    "Origin": "https://smailpro.com",
}


# ============================================================================
# Data Classes
# ============================================================================

@dataclass
class EmailMessage:
    """Represents an email message."""
    mid: str
    from_email: str
    from_name: str
    subject: str
    date: str
    timestamp: int
    body: Optional[str] = None
    body_html: Optional[str] = None
    attachments: List[Dict] = field(default_factory=list)

    def __str__(self):
        return (
            f"Message #{self.mid}\n"
            f"  From:    {self.from_name} <{self.from_email}>\n"
            f"  Subject: {self.subject}\n"
            f"  Date:    {self.date}"
        )


@dataclass
class TempEmail:
    """Represents a temporary email account."""
    email: str
    timestamp: int
    messages: List[EmailMessage] = field(default_factory=list)

    def __str__(self):
        msg_count = len(self.messages)
        return f"Email: {self.email} ({msg_count} message{'s' if msg_count != 1 else ''})"


# ============================================================================
# SmailPro Client
# ============================================================================

class SmailProClient:
    """
    Wrapper for smailpro.com temporary email service.
    
    This client reverse-engineers the website's internal API to provide
    programmatic access to temporary email functionality.
    """

    def __init__(self, state_file: Path = STATE_FILE):
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self.state_file = state_file
        self.current_email: Optional[TempEmail] = None
        self._load_state()

    def _load_state(self):
        """Load saved email state from disk."""
        if self.state_file.exists():
            try:
                with open(self.state_file, 'r') as f:
                    data = json.load(f)
                self.current_email = TempEmail(
                    email=data['email'],
                    timestamp=data['timestamp'],
                    messages=[EmailMessage(**msg) for msg in data.get('messages', [])]
                )
            except (json.JSONDecodeError, KeyError):
                self.current_email = None

    def _save_state(self):
        """Save current email state to disk."""
        if self.current_email:
            data = {
                'email': self.current_email.email,
                'timestamp': self.current_email.timestamp,
                'messages': [
                    {
                        'mid': m.mid,
                        'from_email': m.from_email,
                        'from_name': m.from_name,
                        'subject': m.subject,
                        'date': m.date,
                        'timestamp': m.timestamp,
                        'body': m.body,
                        'body_html': m.body_html,
                        'attachments': m.attachments,
                    }
                    for m in self.current_email.messages
                ]
            }
            with open(self.state_file, 'w') as f:
                json.dump(data, f, indent=2)

    def _get_payload(self, url: str, email: Optional[str] = None, mid: Optional[str] = None) -> Optional[str]:
        """
        Get a payload token from smailpro.com.
        
        This is a required step before making API calls - the website uses
        this as a form of request validation.
        """
        params = {'url': url}
        if email:
            params['email'] = email
        if mid:
            params['mid'] = mid

        try:
            response = self.session.get(PAYLOAD_URL, params=params, timeout=10)
            response.raise_for_status()
            return response.text.strip()
        except requests.RequestException as e:
            print(f"Error getting payload: {e}")
            return None

    def _api_request(self, endpoint: str, params: Optional[Dict] = None) -> Optional[Dict]:
        """Make a request to the SmailPro API."""
        url = f"{BASE_API_URL}{endpoint}"
        
        try:
            response = self.session.get(url, params=params, timeout=15)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            print(f"API request failed: {e}")
            return None
        except json.JSONDecodeError as e:
            print(f"Invalid JSON response: {e}")
            return None

    def create_email(self, custom_name: Optional[str] = None) -> Optional[TempEmail]:
        """
        Create a new temporary email address.
        
        Args:
            custom_name: Optional custom name for the email (before the @)
            
        Returns:
            TempEmail object or None if failed
        """
        # Step 1: Get payload token
        payload = self._get_payload(f"{BASE_API_URL}/create", email=custom_name)
        if not payload:
            return None

        # Step 2: Create email via API
        params = {'payload': payload}
        if custom_name:
            params['email'] = custom_name

        data = self._api_request('/create', params=params)
        if not data:
            return None

        self.current_email = TempEmail(
            email=data['email'],
            timestamp=data.get('timestamp', int(time.time())),
            messages=[]
        )
        self._save_state()
        return self.current_email

    def refresh_email(self, email: Optional[str] = None) -> Optional[TempEmail]:
        """
        Refresh/reconnect to an existing email address.
        
        Args:
            email: Email address to refresh (uses current if None)
        """
        email = email or (self.current_email.email if self.current_email else None)
        if not email:
            return self.create_email()

        return self.create_email(custom_name=email.split('@')[0])

    def check_inbox(self) -> List[EmailMessage]:
        """
        Check inbox for new messages.
        
        Returns:
            List of EmailMessage objects
        """
        if not self.current_email:
            print("No active email. Create one first with: create")
            return []

        email = self.current_email.email

        # Step 1: Get payload token
        payload = self._get_payload(f"{BASE_API_URL}/inbox", email=email)
        if not payload:
            return []

        # Step 2: Fetch inbox
        params = {'payload': payload}
        data = self._api_request('/inbox', params=params)
        if not data or 'messages' not in data:
            return []

        # Parse messages
        new_messages = []
        existing_mids = {m.mid for m in self.current_email.messages}

        for msg_data in data['messages']:
            msg = EmailMessage(
                mid=msg_data.get('mid', ''),
                from_email=msg_data.get('from', msg_data.get('from_email', '')),
                from_name=msg_data.get('fromName', msg_data.get('from_name', '')),
                subject=msg_data.get('subject', ''),
                date=msg_data.get('date', ''),
                timestamp=msg_data.get('timestamp', 0),
                body=msg_data.get('body'),
                body_html=msg_data.get('body_html'),
                attachments=msg_data.get('attachments', []),
            )
            new_messages.append(msg)

            # Add new messages to current email
            if msg.mid not in existing_mids:
                self.current_email.messages.insert(0, msg)

        self._save_state()
        return self.current_email.messages

    def read_message(self, mid: str) -> Optional[EmailMessage]:
        """
        Read a specific message by its ID.
        
        Args:
            mid: Message ID
            
        Returns:
            EmailMessage with full body content or None
        """
        if not self.current_email:
            print("No active email.")
            return None

        email = self.current_email.email

        # Check if we already have the body cached
        for msg in self.current_email.messages:
            if msg.mid == mid and msg.body:
                return msg

        # Step 1: Get payload token
        payload = self._get_payload(f"{BASE_API_URL}/message", email=email, mid=mid)
        if not payload:
            return None

        # Step 2: Fetch message
        params = {'payload': payload}
        data = self._api_request('/message', params=params)
        if not data:
            return None

        # Parse message body
        body = data.get('body', '')
        # Add target="_blank" to links (mimicking website behavior)
        body = body.replace('href="', 'target="_blank" href="')
        body = body.replace("href='", 'target="_blank" href=\'')

        message = EmailMessage(
            mid=data.get('mid', mid),
            from_email=data.get('from', data.get('from_email', '')),
            from_name=data.get('fromName', data.get('from_name', '')),
            subject=data.get('subject', ''),
            date=data.get('date', ''),
            timestamp=data.get('timestamp', 0),
            body=body,
            body_html=body,
            attachments=data.get('attachments', []),
        )

        # Update or add to current messages
        for i, existing in enumerate(self.current_email.messages):
            if existing.mid == mid:
                self.current_email.messages[i] = message
                break
        else:
            self.current_email.messages.insert(0, message)

        self._save_state()
        return message

    def delete_email(self):
        """Delete the current email and state."""
        self.current_email = None
        if self.state_file.exists():
            self.state_file.unlink()
        print("Email deleted.")

    def get_email(self) -> Optional[str]:
        """Get the current email address."""
        return self.current_email.email if self.current_email else None


# ============================================================================
# CLI Interface
# ============================================================================

def print_banner():
    """Print a nice banner."""
    print("=" * 60)
    print("  SmailPro Wrapper - Temporary Email Client")
    print("=" * 60)


def print_messages(messages: List[EmailMessage]):
    """Pretty print a list of messages."""
    if not messages:
        print("\n  No messages in inbox.")
        return

    print(f"\n  Found {len(messages)} message(s):\n")
    print("  " + "-" * 56)
    for i, msg in enumerate(messages, 1):
        print(f"  [{i}] ID: {msg.mid}")
        print(f"      From:    {msg.from_name} <{msg.from_email}>")
        print(f"      Subject: {msg.subject}")
        print(f"      Date:    {msg.date}")
        print("  " + "-" * 56)


def cmd_create(client: SmailProClient, args: List[str]):
    """Handle 'create' command."""
    custom_name = None
    if '--email' in args:
        idx = args.index('--email')
        if idx + 1 < len(args):
            custom_name = args[idx + 1]

    print("\nCreating temporary email...")
    email = client.create_email(custom_name)
    if email:
        print(f"\n  Email created successfully!")
        print(f"  Address: {email.email}")
        print(f"\n  Save this address - you'll need it to check messages.")
    else:
        print("\n  Failed to create email. Please try again.")


def cmd_inbox(client: SmailProClient, args: List[str]):
    """Handle 'inbox' command."""
    if not client.current_email:
        print("\nNo active email. Create one first:")
        print("  python smailpro_wrapper.py create")
        return

    print(f"\nChecking inbox for: {client.current_email.email}")
    messages = client.check_inbox()
    print_messages(messages)


def cmd_read(client: SmailProClient, args: List[str]):
    """Handle 'read' command."""
    if not args:
        print("\nUsage: python smailpro_wrapper.py read <message_id>")
        print("\nAvailable messages:")
        if client.current_email:
            print_messages(client.current_email.messages)
        return

    mid = args[0]
    print(f"\nReading message {mid}...")
    message = client.read_message(mid)

    if message:
        print("\n" + "=" * 60)
        print(f"From:    {message.from_name} <{message.from_email}>")
        print(f"Subject: {message.subject}")
        print(f"Date:    {message.date}")
        print("=" * 60)
        
        # Try to extract text from HTML body
        body = message.body or ""
        if body:
            # Simple HTML tag stripping for text display
            import re
            text_body = re.sub(r'<[^>]+>', '', body)
            text_body = re.sub(r'\s+', ' ', text_body).strip()
            print("\n" + text_body[:2000])  # Limit output
            if len(text_body) > 2000:
                print("\n... [truncated]")
        else:
            print("\n  (No body content)")
        print("=" * 60)
    else:
        print(f"\n  Failed to read message {mid}")


def cmd_monitor(client: SmailProClient, args: List[str]):
    """Handle 'monitor' command - auto-refresh inbox."""
    if not client.current_email:
        print("\nNo active email. Create one first:")
        print("  python smailpro_wrapper.py create")
        return

    interval = 10  # seconds
    if '--interval' in args:
        idx = args.index('--interval')
        if idx + 1 < len(args):
            interval = int(args[idx + 1])

    print(f"\nMonitoring inbox for: {client.current_email.email}")
    print(f"Refresh interval: {interval}s")
    print("Press Ctrl+C to stop.\n")

    try:
        last_count = len(client.current_email.messages)
        while True:
            messages = client.check_inbox()
            new_count = len(messages)

            if new_count > last_count:
                new_messages = messages[:new_count - last_count]
                print(f"\n  [{datetime.now().strftime('%H:%M:%S')}] 📬 {new_count - last_count} new message(s)!")
                for msg in new_messages:
                    print(f"    From:    {msg.from_name} <{msg.from_email}>")
                    print(f"    Subject: {msg.subject}")
                    print()
                last_count = new_count
            else:
                print(f"  [{datetime.now().strftime('%H:%M:%S')}] No new messages ({new_count} total)", end='\r')

            time.sleep(interval)
    except KeyboardInterrupt:
        print("\n\n  Monitoring stopped.")


def cmd_status(client: SmailProClient, args: List[str]):
    """Handle 'status' command."""
    if client.current_email:
        print(f"\n  Active email: {client.current_email.email}")
        print(f"  Messages: {len(client.current_email.messages)}")
        print(f"  Created: {datetime.fromtimestamp(client.current_email.timestamp).strftime('%Y-%m-%d %H:%M:%S')}")
    else:
        print("\n  No active email session.")
        print("  Create one with: python smailpro_wrapper.py create")


def cmd_delete(client: SmailProClient, args: List[str]):
    """Handle 'delete' command."""
    client.delete_email()


def print_help():
    """Print help information."""
    print("""
Usage: python smailpro_wrapper.py <command> [options]

Commands:
  create [--email NAME]   Create a new temporary email
  inbox                   Check inbox for messages
  read <message_id>       Read a specific message
  monitor [--interval S]  Auto-refresh inbox (default: 10s)
  status                  Show current email status
  delete                  Delete current email and session
  help                    Show this help message

Examples:
  python smailpro_wrapper.py create
  python smailpro_wrapper.py create --email myname
  python smailpro_wrapper.py inbox
  python smailpro_wrapper.py read abc123
  python smailpro_wrapper.py monitor --interval 5
""")


# ============================================================================
# Main
# ============================================================================

def main():
    client = SmailProClient()

    if len(sys.argv) < 2:
        print_banner()
        print_help()
        return

    command = sys.argv[1].lower()
    args = sys.argv[2:]

    commands = {
        'create': cmd_create,
        'inbox': cmd_inbox,
        'read': cmd_read,
        'monitor': cmd_monitor,
        'status': cmd_status,
        'delete': cmd_delete,
        'help': lambda c, a: print_help(),
    }

    if command in commands:
        commands[command](client, args)
    else:
        print(f"Unknown command: {command}")
        print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
