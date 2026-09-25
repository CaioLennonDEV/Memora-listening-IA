"""IMAP IDLE listener — async, persistent, push-based (no polling).

Uses ``aioimaplib`` (pure-asyncio) for IMAP IDLE so the loop wakes up ONLY when
the server pushes a new-mail notification, never on a timer.  ``mail-parser`` (or
the stdlib ``email`` package as fallback) converts the raw MIME to text + HTML so
``meeting_parser.extract_meeting`` can scan it.

Activation guard: ``IMAP_ENABLED`` must be ``true`` / ``1`` / ``yes`` / ``on``
(default: false — explicit opt-in).  Missing credentials → ``ImapNotConfigured``
which the lifespan hook translates to a warning + no-op, never a boot failure.

The coroutine ``start_email_watcher(on_meeting_found)`` is the single public
interface.  It runs forever (``while True``) and re-connects with exponential backoff
on transport errors — a clean start-up or IMAP timeout never kills the loop.

``on_meeting_found`` is a coroutine callable that receives::

    {
        "platform":    str,          # "teams" | "google_meet" | "zoom" | "jitsi"
        "meeting_url": str,          # the full join URL
        "bot_name":    str,          # default bot name (env IMAP_BOT_NAME)
        "subject":     str,          # raw e-mail subject, for logging
    }

The caller (``__main__._attach_background_loops``) wires this to the internal
``request_bot`` flow so the dispatch is fully in-process: no HTTP, no n8n.
"""
from __future__ import annotations

import asyncio
import email as _email
import logging
import os
import sys
from typing import Awaitable, Callable, Optional

log = logging.getLogger("meeting_api.email_watcher")
if not log.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    log.addHandler(_h)
log.setLevel(logging.INFO)
log.propagate = False

# ── env helpers ─────────────────────────────────────────────────────────────

_TRUE = ("true", "1", "yes", "on")


def _imap_enabled() -> bool:
    """IMAP_ENABLED=false by default — activation is an explicit operator choice."""
    raw = os.getenv("IMAP_ENABLED", "false")
    return raw.strip().lower() in _TRUE


class ImapNotConfigured(RuntimeError):
    """Raised when IMAP is enabled but required credentials are absent."""


def _imap_config() -> dict:
    """Read and validate IMAP credentials from the environment.

    Raises ``ImapNotConfigured`` when a required key is absent so the caller can
    log a clear error instead of receiving a confusing auth failure mid-run.
    """
    user = os.getenv("IMAP_USER", "")
    password = os.getenv("IMAP_PASSWORD", "")
    host = os.getenv("IMAP_HOST", "imap.gmail.com")
    port = int(os.getenv("IMAP_PORT", "993"))
    bot_name = os.getenv("IMAP_BOT_NAME", "Atena")

    if not user or not password:
        raise ImapNotConfigured(
            "IMAP_ENABLED=true but IMAP_USER or IMAP_PASSWORD is not set. "
            "Add them to your .env file."
        )
    return {
        "user": user,
        "password": password,
        "host": host,
        "port": port,
        "bot_name": bot_name,
    }


# ── MIME → text helpers ─────────────────────────────────────────────────────


def _extract_email_info(raw_bytes: bytes) -> dict:
    """Parse raw MIME message → dict with plain, html, cal_text, scheduled_at, calendar_uid, subject."""
    import icalendar
    from datetime import datetime, timezone
    from email.header import decode_header

    msg = _email.message_from_bytes(raw_bytes)
    plain, html_body, cal_text = "", "", ""
    scheduled_at_iso = None
    cal_uid = None
    cal_summary = None

    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            charset = part.get_content_charset() or "utf-8"
            payload = part.get_payload(decode=True)
            if payload is None:
                continue
            try:
                text = payload.decode(charset, errors="replace")
            except Exception:
                text = ""

            if ct == "text/calendar" or (part.get_filename() or "").endswith(".ics"):
                cal_text = text
                try:
                    cal = icalendar.Calendar.from_ical(payload)
                    for comp in cal.walk("VEVENT"):
                        dt_prop = comp.get("DTSTART")
                        if dt_prop:
                            dt = dt_prop.dt
                            if hasattr(dt, "tzinfo") and dt.tzinfo:
                                dt_utc = dt.astimezone(timezone.utc)
                            elif isinstance(dt, datetime):
                                dt_utc = dt.replace(tzinfo=timezone.utc)
                            else:
                                dt_utc = datetime.combine(dt, datetime.min.time(), tzinfo=timezone.utc)
                            scheduled_at_iso = dt_utc.isoformat()
                        if comp.get("SUMMARY"):
                            cal_summary = str(comp.get("SUMMARY"))
                        if comp.get("UID"):
                            cal_uid = str(comp.get("UID"))
                        desc = str(comp.get("DESCRIPTION") or "")
                        loc = str(comp.get("LOCATION") or "")
                        cal_text += f"\n{desc}\n{loc}"
                except Exception:
                    pass
            elif ct == "text/plain" and not plain:
                plain = text
            elif ct == "text/html" and not html_body:
                html_body = text
    else:
        ct = msg.get_content_type()
        charset = msg.get_content_charset() or "utf-8"
        try:
            payload = msg.get_payload(decode=True)
            raw_text = (payload or b"").decode(charset, errors="replace")
        except Exception:
            raw_text = ""
        if ct == "text/html":
            html_body = raw_text
        elif ct == "text/calendar":
            cal_text = raw_text
            try:
                cal = icalendar.Calendar.from_ical(payload or b"")
                for comp in cal.walk("VEVENT"):
                    dt_prop = comp.get("DTSTART")
                    if dt_prop:
                        dt = dt_prop.dt
                        if hasattr(dt, "tzinfo") and dt.tzinfo:
                            dt_utc = dt.astimezone(timezone.utc)
                        elif isinstance(dt, datetime):
                            dt_utc = dt.replace(tzinfo=timezone.utc)
                        else:
                            dt_utc = datetime.combine(dt, datetime.min.time(), tzinfo=timezone.utc)
                        scheduled_at_iso = dt_utc.isoformat()
                    if comp.get("SUMMARY"):
                        cal_summary = str(comp.get("SUMMARY"))
                    if comp.get("UID"):
                        cal_uid = str(comp.get("UID"))
            except Exception:
                pass
        else:
            plain = raw_text

    raw_sub = msg.get("Subject", "")
    try:
        parts = decode_header(raw_sub)
        decoded = []
        for content, enc in parts:
            if isinstance(content, bytes):
                decoded.append(content.decode(enc or "utf-8", errors="replace"))
            else:
                decoded.append(str(content))
        subject = "".join(decoded)
    except Exception:
        subject = str(raw_sub)

    return {
        "plain": plain,
        "html_body": html_body,
        "cal_text": cal_text,
        "scheduled_at": scheduled_at_iso,
        "calendar_uid": cal_uid,
        "subject": cal_summary or subject or "(no subject)",
    }


# ── IMAP session ────────────────────────────────────────────────────────────


async def _process_unseen(imap, cfg: dict, on_meeting_found: Callable) -> None:
    """Fetch every UNSEEN message and call ``on_meeting_found`` for each meeting."""
    from .meeting_parser import extract_meeting

    # Search for unseen messages
    _status, data = await imap.search("UNSEEN")
    if not data or not data[0]:
        return

    raw_ids = data[0].split()
    if not raw_ids:
        return

    uid_list = b",".join(raw_ids)
    # Fetch full RFC 822 body
    _fs, fetch_data = await imap.fetch(
        uid_list.decode(), "(RFC822)",
    )

    for chunk in fetch_data:
        raw = None
        if isinstance(chunk, tuple) and len(chunk) == 2:
            raw = chunk[1]
        elif isinstance(chunk, bytearray):
            raw = bytes(chunk)
        elif (
            isinstance(chunk, bytes)
            and not chunk.startswith(b")")
            and b"FETCH completed" not in chunk
            and b"FETCH (" not in chunk
        ):
            raw = chunk

        if not raw:
            continue

        info = _extract_email_info(raw)
        meeting = extract_meeting(
            info["plain"],
            info["html_body"],
            subject=info["subject"],
            extra_text=info["cal_text"],
        )

        if meeting:
            log.info(
                "[EmailWatcher] meeting link detected (%s): %s — subject: %r, scheduled_at: %s",
                meeting["platform"],
                meeting["meeting_url"],
                info["subject"],
                info["scheduled_at"] or "(immediate)",
            )
            try:
                await on_meeting_found(
                    {
                        "platform": meeting["platform"],
                        "meeting_url": meeting["meeting_url"],
                        "bot_name": cfg["bot_name"],
                        "subject": info["subject"],
                        "scheduled_at": info["scheduled_at"],
                        "calendar_uid": None,
                    }
                )
            except Exception:  # noqa: BLE001
                log.exception("[EmailWatcher] on_meeting_found callback raised")
        elif info["scheduled_at"]:
            log.info(
                "[EmailWatcher] calendar event detected (no meeting link): %r — scheduled_at: %s",
                info["subject"],
                info["scheduled_at"],
            )
            try:
                await on_meeting_found(
                    {
                        "platform": "unknown",
                        "meeting_url": None,
                        "bot_name": cfg["bot_name"],
                        "subject": info["subject"],
                        "scheduled_at": info["scheduled_at"],
                        "calendar_uid": None,
                    }
                )
            except Exception:  # noqa: BLE001
                log.exception("[EmailWatcher] on_meeting_found callback raised")

    # Mark as seen (STORE +FLAGS \Seen)
    await imap.store(uid_list.decode(), "+FLAGS", r"(\Seen)")


async def _run_once(imap_config: dict, on_meeting_found: Callable) -> None:
    """Open one IMAP IDLE session and run until the connection drops."""
    import aioimaplib  # imported lazily — not in the offline gate venv

    imap = aioimaplib.IMAP4_SSL(host=imap_config["host"], port=imap_config["port"])
    await imap.wait_hello_from_server()
    await imap.login(imap_config["user"], imap_config["password"])
    await imap.select("INBOX")

    log.info("[EmailWatcher] connected — listening for meeting invites on %s", imap_config["user"])

    # Process any messages that arrived while we were offline
    await _process_unseen(imap, imap_config, on_meeting_found)

    while True:
        # IDLE: tell the server to push notifications instead of us polling.
        # wait_server_push blocks until a push arrives OR timeout (seconds).
        # Per RFC 3501, IDLE sessions should be refreshed every ~29 minutes.
        idle_task = await imap.idle_start(timeout=1740)
        try:
            push_lines = await imap.wait_server_push(timeout=1740)  # 29 min
        except asyncio.TimeoutError:
            push_lines = None
        finally:
            imap.idle_done()
            try:
                await asyncio.wait_for(idle_task, timeout=10)
            except Exception:
                pass

        # Any push (EXISTS = new mail, EXPUNGE, FLAGS) triggers a UNSEEN scan.
        if push_lines:
            log.debug("[EmailWatcher] server push received, scanning INBOX…")
        await _process_unseen(imap, imap_config, on_meeting_found)


# ── public entrypoint ───────────────────────────────────────────────────────


async def start_email_watcher(
    on_meeting_found: Callable[[dict], Awaitable[None]],
) -> None:
    """Run the IMAP watcher forever, reconnecting on error.

    This is the coroutine the lifespan wraps in ``asyncio.create_task()``.  It
    returns only when the parent task is cancelled (shutdown).

    If ``IMAP_ENABLED`` is false (the default) or credentials are missing this
    function logs once and returns immediately — it never raises.
    """
    if not _imap_enabled():
        log.debug("[EmailWatcher] IMAP_ENABLED is not set — email watcher disabled")
        return

    try:
        cfg = _imap_config()
    except ImapNotConfigured as exc:
        log.warning("[EmailWatcher] disabled: %s", exc)
        return

    backoff = 5.0
    while True:
        try:
            await _run_once(cfg, on_meeting_found)
        except asyncio.CancelledError:
            log.info("[EmailWatcher] shutting down")
            raise
        except Exception:
            log.exception(
                "[EmailWatcher] connection lost — retrying in %.0fs", backoff
            )
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 300)  # cap at 5 min
        else:
            backoff = 5.0  # reset on a clean exit
