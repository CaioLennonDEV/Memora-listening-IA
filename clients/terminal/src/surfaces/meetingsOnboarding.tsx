"use client";
/** Meetings user onboarding — the per-user half of the first-run flow (design-spec
 *  first-run-onboarding, frames 4–5). EVERY new user lands here; the admin wizard hands into it
 *  via "Go to Meetings". Two skins over one state:
 *
 *    - `full` — the empty-Meetings center stage: three cards ordered by leverage (connect
 *      calendar / plan a meeting / drop a bot on a running Meet).
 *    - `slim` — the STANDING calendar affordance: a single connect card that stays on the
 *      Meetings page for as long as THIS user has no calendar connected (state-driven, not
 *      visit-count-driven). Renders nothing once connected.
 *
 *  The connect surface TEACHES where the secret iCal URL lives (the step users bounce off),
 *  including the two field-tested traps (public-vs-secret address, Workspace-admin lock), and
 *  answers immediately on connect — sync-now runs and reports what it found. */
import { useEffect, useState, type CSSProperties } from "react";
import { defaultBotName } from "./defaultBotName";
import { useService } from "../platform";
import { LayoutServiceId } from "../workbench/layout";
import { Icon } from "../ui-kit";
import { parseMeetingInput } from "./meetingId";
import { readApiFailure } from "./apiClient";
import { resolveJoinError, type ServiceDenialPresentation } from "./serviceDenial";
import { ServiceDenialPanel } from "./ServiceDenialPanel";
import { getJitsiHosts } from "./jitsiHosts";
import { presentError } from "./apiClient";
import { refreshMeetings } from "./liveMeetings";
import { listCalendars, createCalendar, syncCalendar, type CalendarSyncStamp } from "./plannedApi";
import { prepDraftTabDescriptor } from "./meetingPrep";

/** The success line after a connect: lead with what the sync actually FOUND. */
export function connectOutcome(stamp: CalendarSyncStamp): { ok: boolean; text: string } {
  if (stamp.last_error) return { ok: false, text: `Feed connected but the first sync failed: ${stamp.last_error}` };
  const found = (stamp.counts?.created ?? 0) + (stamp.counts?.updated ?? 0);
  return {
    ok: true,
    text: found > 0
      ? `Feed connected — ${found} upcoming meeting${found === 1 ? "" : "s"} imported.`
      : "Feed connected — no upcoming meetings with joinable links found yet.",
  };
}

const cardBase: CSSProperties = {
  border: "1px dashed var(--line2)", borderRadius: 10, padding: "14px 15px",
  display: "flex", flexDirection: "column", gap: 6, textAlign: "left",
};
const cardTitle: CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--t1)", display: "flex", alignItems: "center", gap: 7 };
const cardBody: CSSProperties = { fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5, flex: 1 };
const cta: CSSProperties = { fontSize: 12.5, fontWeight: 600, color: "var(--accent)", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" };
const fieldStyle: CSSProperties = {
  flex: 1, minWidth: 0, background: "var(--panel2)", border: "1px solid var(--line2)", borderRadius: 7,
  padding: "7px 9px", color: "var(--t1)", fontSize: 12, outline: "none",
};

/** Loading tri-state so neither skin flashes: null = unknown yet. "Connected" is now "this user
 *  has at least one calendar CONNECTION" — the first-run card is about having none at all; the
 *  second, third… calendar is added from Settings → Calendar. */
function useCalendarConnected(): [boolean | null, () => void] {
  const [connected, setConnected] = useState<boolean | null>(null);
  const probe = () => {
    listCalendars().then((l) => setConnected(l.length > 0)).catch(() => setConnected(null));
  };
  useEffect(probe, []);
  return [connected, probe];
}

/** The frame-5 connect modal: numbered secret-address walkthrough + paste + instant verdict.
 *  This is FIRST-connect only, so it creates connection #1 with a sensible default name; renaming
 *  it, adding more, and per-calendar policy all live in Settings → Calendar. */
const DEFAULT_CALENDAR_NAME = "My calendar";

function ConnectCalendarModal({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState(DEFAULT_CALENDAR_NAME);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ ok: boolean; text: string } | null>(null);

  const connect = async () => {
    const u = url.trim();
    if (!u || busy) return;
    setBusy(true); setErr(null); setDone(null);
    try {
      const created = await createCalendar({
        name: name.trim() || DEFAULT_CALENDAR_NAME, ics_url: u, auto_join: true,
      });
      // paste → an ANSWER, not a silent wait (the backend does not sync on create)
      let stamp: CalendarSyncStamp = {};
      try { stamp = await syncCalendar(created.id); } catch (e) {
        stamp = { last_error: presentError(e).detail };  // data stays raw (telemetry) — UI renders the presented stamp
      }
      refreshMeetings();
      setDone(connectOutcome(stamp));
      onConnected();
    } catch (e) {
      setErr(presentError(e).headline);
    } finally {
      setBusy(false);
    }
  };

  const li: CSSProperties = { display: "flex", gap: 10, padding: "7px 0", borderBottom: "1px dashed var(--line)", fontSize: 12, color: "var(--t2)", lineHeight: 1.5 };
  const num: CSSProperties = { flex: "none", width: 18, height: 18, borderRadius: "50%", background: "var(--panel2)", color: "var(--accent)", fontSize: 10.5, fontWeight: 700, display: "grid", placeItems: "center", marginTop: 1 };

  return (
    <div role="dialog" aria-label="Connect your calendar"
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: 520, maxWidth: "92vw", maxHeight: "88vh", overflowY: "auto", background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 12, padding: "20px 22px", boxShadow: "0 18px 40px rgba(0,0,0,.5)", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <span style={{ fontSize: 15, fontWeight: 650, color: "var(--t1)", flex: 1 }}>Connect your calendar</span>
          <button aria-label="close" onClick={onClose} style={{ background: "none", border: "none", color: "var(--t3)", fontSize: 16, cursor: "pointer", padding: 2 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 1.5 }}>
          Memora reads your calendar through its <b style={{ color: "var(--t2)" }}>secret iCal address</b> — a
          private URL only you can see. No Google sign-in needed. Outlook and Apple Calendar ICS feeds work
          through the same box.
        </div>
        <div>
          <div style={li}><span style={num}>1</span><span>Open <b>Google Calendar</b> on the web → ⚙ <b>Settings</b>.</span></div>
          <div style={li}><span style={num}>2</span><span>In the left list under <b>Settings for my calendars</b>, click your calendar.</span></div>
          <div style={li}><span style={num}>3</span><span>Scroll to <b>Integrate calendar</b> → copy <b>Secret address in iCal format</b>. <span style={{ color: "var(--t3)" }}>Not the public address — the secret one ends in a long token.</span></span></div>
          <div style={{ ...li, borderBottom: "none", color: "var(--t3)" }}><span style={num}>4</span><span>Don&rsquo;t see the secret field? Your Google Workspace admin has it locked — ask them to enable &ldquo;Secret address&rdquo; sharing, or use a personal calendar.</span></div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} maxLength={100}
            aria-label="Calendar name" placeholder="Calendar name"
            style={{ ...fieldStyle, flex: "none", width: 130 }} />
          <input value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy}
            type="password" autoComplete="off" aria-label="Secret ICS address"
            onKeyDown={(e) => { if (e.key === "Enter") void connect(); }}
            placeholder="https://calendar.google.com/…/basic.ics (secret address)" style={fieldStyle} />
          <button onClick={() => void connect()} disabled={busy || !url.trim()}
            style={{ flex: "none", background: url.trim() ? "var(--accent)" : "var(--panel2)", color: url.trim() ? "var(--on-accent)" : "var(--t3)", border: "none", borderRadius: 7, padding: "0 14px", fontSize: 12.5, fontWeight: 600, cursor: url.trim() && !busy ? "pointer" : "default" }}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
        {err && <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)", lineHeight: 1.5 }}>⚠ {err}</div>}
        {done && (
          <div role={done.ok ? "status" : "alert"} style={{ fontSize: 11.5, color: done.ok ? "var(--green)" : "var(--danger)", lineHeight: 1.5 }}>
            {done.ok ? "✓" : "⚠"} {done.text}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "var(--t3)" }}>Synced every few minutes · add more calendars, rename or disconnect in Settings → Calendar</span>
          {done?.ok && <button onClick={onClose} style={{ background: "var(--accent)", color: "var(--on-accent)", border: "none", borderRadius: 7, padding: "7px 16px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>Done</button>}
        </div>
      </div>
    </div>
  );
}

/** The drop-a-bot card's inline sender — same POST /api/bots edge and error taxonomy as the sidebar. */
function DropBotInline() {
  const [url, setUrl] = useState("");
  const [sent, setSent] = useState<null | "sending" | "ok" | "err">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [denial, setDenial] = useState<ServiceDenialPresentation | null>(null);
  const send = async () => {
    const u = url.trim();
    if (!u || sent === "sending") return;
    const parsed = parseMeetingInput(u, await getJitsiHosts());
    if (!parsed) { setSent("err"); setMsg("That doesn't look like a Meet / Zoom / Teams / Jitsi link."); setDenial(null); return; }
    setSent("sending"); setMsg(null); setDenial(null);
    try {
      const r = await fetch("/api/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: parsed.platform, native_meeting_id: parsed.native_meeting_id, meeting_url: u, bot_name: defaultBotName() }),
      });
      if (r.ok) {
        setSent("ok"); setUrl("");
        refreshMeetings(); setTimeout(refreshMeetings, 2000); setTimeout(refreshMeetings, 6000);
      } else {
        setSent("err");
        if (r.status === 429) setMsg("You're at your meeting limit — stop one first.");
        else if (r.status === 409) setMsg("That meeting already has a bot.");
        else if (r.status === 401) setMsg("Not signed in — sign in and retry.");
        else {
          const state = resolveJoinError(await readApiFailure(r, "/api/bots"));
          if (state.kind === "denial") { setDenial(state.presentation); setMsg(null); }
          else setMsg(state.headline);
        }
      }
    } catch { setSent("err"); setMsg("Couldn't reach the server."); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        background: "var(--panel)",
        border: "1px solid var(--line2)",
        borderRadius: 8,
        padding: "3px 4px 3px 10px",
        gap: 8,
        boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
      }}>
        <Icon name="video" size={14} style={{ color: "var(--t3)", flex: "none" }} />
        <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
          placeholder="Paste a meeting link (Meet / Zoom / Teams / Jitsi)…"
          style={{
            flex: 1, minWidth: 0, background: "transparent", border: "none", color: "var(--t1)",
            fontSize: 12.5, outline: "none", padding: "4px 0"
          }} />
        <button onClick={() => void send()} disabled={!url.trim() || sent === "sending"}
          style={{
            flex: "none",
            background: url.trim() ? "var(--green)" : "var(--panel2)",
            color: url.trim() ? "var(--on-green)" : "var(--t3)",
            border: "none",
            borderRadius: 6,
            padding: "5px 12px",
            fontSize: 12,
            fontWeight: 600,
            cursor: url.trim() ? "pointer" : "default",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            transition: "background 0.15s ease",
          }}>
          <Icon name="send" size={12} />
          {sent === "sending" ? "…" : "Send bot"}
        </button>
      </div>
      {sent === "ok" && (
        <div style={{ fontSize: 11.5, color: "var(--green)", lineHeight: 1.4, display: "flex", alignItems: "center", gap: 5 }}>
          <Icon name="check" size={12} /> Bot sent — admit it in the meeting; it appears here once it starts transcribing.
        </div>
      )}
      {denial
        ? <ServiceDenialPanel presentation={denial} onRetry={() => void send()} />
        : sent === "err" && msg && (
          <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)", lineHeight: 1.4, display: "flex", alignItems: "center", gap: 5 }}>
            <Icon name="alert" size={12} /> {msg}
          </div>
        )}
    </div>
  );
}

export function MeetingsOnboarding({ variant }: { variant: "full" | "slim" }) {
  const [connected, reprobe] = useCalendarConnected();
  const [modal, setModal] = useState(false);
  const layout = useService(LayoutServiceId);
  const plan = () => layout.openTab(prepDraftTabDescriptor());

  if (variant === "slim") {
    return (
      <>
        {connected === false && (
          <div style={{
            ...cardBase,
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            marginTop: 12,
            background: "var(--panel)",
            border: "1px solid var(--line2)",
            borderRadius: 10,
            padding: "12px 16px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.02)",
          }}>
            <div style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "var(--greenbg)",
              color: "var(--green)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "none",
            }}>
              <Icon name="cal" size={16} />
            </div>
            <span style={{ ...cardBody, flex: 1, fontSize: 12 }}>
              <b style={{ color: "var(--t1)" }}>No calendar connected</b> — connect your calendar&rsquo;s secret
              ICS feed and scheduled meetings appear here by themselves.
            </span>
            <button
              style={{
                ...cta,
                flex: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                background: "var(--greenbg)",
                color: "var(--green)",
                padding: "6px 12px",
                borderRadius: 7,
              }}
              onClick={() => setModal(true)}
            >
              Connect calendar →
            </button>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
          <button
            onClick={() => plan()}
            style={{
              flex: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "var(--panel)",
              border: "1px solid var(--line2)",
              color: "var(--t1)",
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
              transition: "all 0.15s ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--panel2)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--panel)"; }}
          >
            <Icon name="plus" size={13} style={{ color: "var(--green)" }} />
            Plan a meeting
          </button>
          <div style={{ flex: 1, minWidth: 260 }}><DropBotInline /></div>
        </div>
        {modal && <ConnectCalendarModal onClose={() => setModal(false)} onConnected={reprobe} />}
      </>
    );
  }

  // full = the empty-Meetings center stage (frame 4): three paths, calendar primary.
  return (
    <>
      <div style={{ marginTop: 14, fontSize: 12.5, color: "var(--t3)" }}>
        Nothing here yet — pick how meetings should arrive.
      </div>
      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        {connected !== true && (
          <div style={{ ...cardBase, border: "1px solid var(--accent)", background: "var(--panel)" }}>
            <span style={cardTitle}><Icon name="cal" size={14} /> Connect your calendar</span>
            <span style={cardBody}>
              One-time setup. Scheduled meetings appear here by themselves; with auto-join on, the bot joins
              when they start.
            </span>
            <button style={cta} onClick={() => setModal(true)}>Connect calendar →</button>
          </div>
        )}
        <div style={cardBase}>
          <span style={cardTitle}><Icon name="plus" size={14} /> Plan a meeting</span>
          <span style={cardBody}>Create one meeting by hand — title, time, Meet link. Good for a first trial run.</span>
          <button style={cta} onClick={() => plan()}>+ Plan a meeting</button>
        </div>
        <div style={cardBase}>
          <span style={cardTitle}><Icon name="send" size={14} /> Drop a bot in now</span>
          <span style={cardBody}>Send the notetaker into a meeting that&rsquo;s already running.</span>
          <DropBotInline />
        </div>
      </div>
      {connected === true && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--t3)" }}>
          ✓ Calendar connected — scheduled meetings appear here as they sync. Add more calendars in Settings → Calendar.
        </div>
      )}
      {modal && <ConnectCalendarModal onClose={() => setModal(false)} onConnected={reprobe} />}
    </>
  );
}
