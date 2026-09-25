# email_watcher — IMAP IDLE listener for meeting invite auto-dispatch

Watches a configured Gmail (or standard IMAP) inbox via IMAP IDLE push notifications and automatically dispatches bots via the internal `request_bot` flow when meeting invitations arrive — no external orchestrators (n8n), webhooks, or exposed localhost required.

## Public surface
- `start_email_watcher(on_meeting_found)` — pure-asyncio persistent IMAP IDLE listener using `aioimaplib`. Runs continuously with exponential backoff on transport errors.
- `extract_meeting(text, html_body, subject, extra_text)` — scans email text/HTML for meeting links (Teams, Google Meet, Zoom, Jitsi), sanitizing entities and delegating to `collector.meeting_link.find_meeting_link`.

## Configuration
Controlled via `config.v1.json` optional-explicit settings:
- `IMAP_ENABLED` (`false` by default, explicit opt-in).
- `IMAP_USER`, `IMAP_PASSWORD`, `IMAP_HOST`, `IMAP_PORT`.
- `IMAP_BOT_NAME` (bot display name when joining).
- `IMAP_USER_ID` (Vexa user ID under whose quota bots run).

If `IMAP_ENABLED` is false or credentials are unset, the background loop logs an informational message and no-ops without failing service boot.
