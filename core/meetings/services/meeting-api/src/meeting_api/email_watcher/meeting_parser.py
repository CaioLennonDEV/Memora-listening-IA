"""meeting_parser — extract the first recognizable meeting URL from an e-mail.

Delegates to the existing ``collector.meeting_link.find_meeting_link`` (the same
scanner the ICS / calendar-sync flow uses), so Teams /meet/ short links, Google Meet,
and Zoom links all resolve through one tested code path.

The sanitization step (``&amp;`` → ``&``, trailing punctuation) replicates the regex
clean-ups the Node.js prototype applied before Vexa's parser existed.  They are
preserved here because an HTML e-mail body can contain encoded entities and trailing
angle brackets from inline HTML anchors.
"""
from __future__ import annotations

import html
import re
from typing import Optional


def extract_meeting(
    text: Optional[str],
    html_body: Optional[str],
    subject: Optional[str] = None,
    extra_text: Optional[str] = None,
) -> Optional[dict]:
    """Scan e-mail content for the first meeting link.

    Returns ``{"platform": str, "meeting_url": str}`` or ``None`` when nothing is
    found.  The combined scan order matches the priority
    the original Node.js prototype applied.
    """
    from ..collector.meeting_link import find_meeting_link

    # Collapse HTML entities (e.g. &amp; → &) before scanning the HTML part so URLs
    # survive the round-trip through an HTML mailer that encodes query-string chars.
    parts = [
        text or "",
        html.unescape(html_body or ""),
        extra_text or "",
        subject or "",
    ]

    for part in parts:
        result = find_meeting_link(part)
        if result:
            platform, _native_id, url = result
            # Strip trailing punctuation that can bleed into a bare URL inside an
            # HTML tag attribute or a sentence («…join here: <url>.»).
            url = re.sub(r"[>.,;]+$", "", url)
            return {"platform": platform, "meeting_url": url}

    return None
