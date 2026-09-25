"""email_watcher — IMAP IDLE listener that auto-dispatches bots from meeting invites.

Watches a configured Gmail (or any IMAP) inbox via IMAP IDLE (push notification) and
calls the internal ``request_bot`` flow the moment a meeting invite arrives — no n8n,
no HTTP round-trip, no exposed localhost.

Activation is controlled by ``IMAP_ENABLED`` (default false — explicit opt-in).
All credentials are declared in ``config.v1.json`` as ``optional-explicit`` keys:
  IMAP_USER, IMAP_PASSWORD, IMAP_HOST, IMAP_PORT.

The module is self-contained: it imports nothing from the rest of meeting_api at module
level, so the offline gate venv stays clean.
"""
from .watcher import start_email_watcher

__all__ = ["start_email_watcher"]
