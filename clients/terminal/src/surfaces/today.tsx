"use client";
/** Today — the Meetings surface's CENTER tab, v5 AGENDA TIMELINE (design-spec
 *  today-v5-agenda-timeline, owner-approved mockup). ONE time axis:
 *
 *    "Coming up"  — a day-grouped agenda card for the visible week (‹ › pages weeks). A live
 *                   meeting shows IN PLACE on its day row (green bar) — no separate NOW zone.
 *    past feed    — reverse-chron day-grouped rows below: faces · title · one state phrase.
 *
 *  RENDERING LAW (binding): a meeting row is ONE line — title + time (+ faces on past rows).
 *  The ONLY extra ink is ONE inline deviation phrase (`in meeting →` · `couldn't import` ·
 *  `no brief yet` · `recap ready`), each deep-linking to the right page. A prepared meeting is
 *  the quiet default and carries NO phrase. Depth lives on the per-state pages, not here.
 *  Supersedes the v4 zones (NOW/NEXT/THIS WEEK/LATER/TO REVIEW) — same intent, less vocabulary. */
import { useEffect, useState, useSyncExternalStore } from "react";
import { registerTab } from "../contributions";
import { Icon } from "../ui-kit";
import { useService } from "../platform";
import { LayoutServiceId } from "../workbench/layout";
import { usePreviewPinTab } from "./previewPinTab";
import type { MeetingMock } from "./meetingModel";
import { useLiveMeetings, fetchDurableTranscript } from "./liveMeetings";
import { groupMeetings, type MeetingGroup } from "./meetingGroups";
import { meetingTab } from "./meeting";
import { MeetingsOnboarding } from "./meetingsOnboarding";
import { findBriefNote } from "./briefNote";
import { listWorkspaceTree } from "./workspaceApi";

// ── reviewed-recaps store (localStorage) — opening a recap retires its phrase ──────────────────
const REVIEWED_KEY = "vexa.reviewedMeetings";
let reviewed: Set<string> = new Set();
try { reviewed = new Set(JSON.parse(localStorage.getItem(REVIEWED_KEY) ?? "[]") as string[]); } catch { /* fresh */ }
const reviewedSubs = new Set<() => void>();
let reviewedSnapshot: string[] = [...reviewed];
export function markReviewed(runId: string): void {
  if (reviewed.has(runId)) return;
  reviewed.add(runId);
  reviewedSnapshot = [...reviewed];
  try { localStorage.setItem(REVIEWED_KEY, JSON.stringify(reviewedSnapshot.slice(-500))); } catch { /* quota */ }
  reviewedSubs.forEach((f) => f());
}
function useReviewed(): Set<string> {
  useSyncExternalStore(
    (cb) => { reviewedSubs.add(cb); return () => reviewedSubs.delete(cb); },
    () => reviewedSnapshot,
    () => reviewedSnapshot,
  );
  return reviewed;
}

// ── pure timeline splitters (unit-tested offline) ─────────────────────────────────────────────
export interface AgendaDay { key: string; date: Date; groups: MeetingGroup[] }

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/** The agenda window: day-grouped upcoming (+live) meetings for the week starting at
 *  today + 7·weekOffset days. Unscheduled plans attach to TODAY (offset 0 only) — they need
 *  attention but have no place on a time axis. Days without events are omitted, except today. */
export function agendaWindow(groups: MeetingGroup[], now: Date = new Date(), weekOffset = 0): AgendaDay[] {
  const start = startOfDay(now);
  start.setDate(start.getDate() + weekOffset * 7);
  const end = new Date(start); end.setDate(end.getDate() + 7);
  const days = new Map<string, AgendaDay>();
  const put = (d: Date, g: MeetingGroup) => {
    const k = dayKey(d);
    let day = days.get(k);
    if (!day) { day = { key: k, date: startOfDay(d), groups: [] }; days.set(k, day); }
    day.groups.push(g);
  };
  for (const g of groups) {
    if (g.phase !== "prep" && g.phase !== "live") continue;
    const at = g.current.scheduled_at ? new Date(g.current.scheduled_at) : null;
    if (at && Number.isFinite(at.getTime())) {
      // a live meeting always shows — clamp a stale/past schedule onto today so it can't vanish
      const slot = g.phase === "live" && at < start ? new Date(now) : at;
      if (slot >= start && slot < end) put(slot, g);
    } else if (weekOffset === 0) {
      put(new Date(now), g);   // unscheduled (or undated live) → today's row, "no time set"
    }
  }
  // today's row always renders on the current week so "No events today" is stated honestly
  if (weekOffset === 0 && !days.has(dayKey(now))) days.set(dayKey(now), { key: dayKey(now), date: startOfDay(now), groups: [] });
  const out = [...days.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const day of out) {
    day.groups.sort((a, b) => (a.current.scheduled_at ?? "9999").localeCompare(b.current.scheduled_at ?? "9999"));
  }
  return out;
}

export interface PastEntry { run: MeetingMock; group: MeetingGroup }
export interface PastDay { key: string; date: Date; entries: PastEntry[] }

const PAST_CAP = 8;

/** The past feed: each meeting's newest finished run, newest first, day-grouped. */
export function pastFeed(groups: MeetingGroup[], cap: number = PAST_CAP): PastDay[] {
  const entries: PastEntry[] = groups
    .filter((g) => g.pastRuns[0] && (g.pastRuns[0].has_recording || g.pastRuns[0].start_time))
    .map((g) => ({ run: g.pastRuns[0], group: g }))
    .sort((a, b) => (b.run.start_time ?? "").localeCompare(a.run.start_time ?? ""))
    .slice(0, cap);
  const days = new Map<string, PastDay>();
  for (const e of entries) {
    const d = e.run.start_time ? new Date(e.run.start_time) : new Date();
    const k = dayKey(d);
    let day = days.get(k);
    if (!day) { day = { key: k, date: startOfDay(d), entries: [] }; days.set(k, day); }
    day.entries.push(e);
  }
  return [...days.values()].sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** ONE deviation phrase per row (the rendering law) — or null for the quiet default.
 *  `hasOwnBrief`: an unbound meeting whose brief lives as this meeting's note in the user's OWN
 *  workspace (frame-6 flow) is PREPARED — quiet, same as a bound workspace. */
export function deviationPhrase(g: MeetingGroup, hasOwnBrief = false): { text: string; tone: "live" | "danger" | "accent" } | null {
  const m = g.current;
  if (g.phase === "live") return { text: "in meeting →", tone: "live" };
  if (m.auto_join_error) return { text: "couldn’t import — no meeting link", tone: "danger" };
  if (!m.native_id && !m.meeting_url) return { text: "no meeting link", tone: "danger" };
  if (!m.workspace_id && !hasOwnBrief) return { text: "no brief yet", tone: "accent" };
  return null;
}

// ── own-workspace brief notes (frame 6): ONE tree fetch feeds every row's phrase ───────────────
const OWN_TREE_POLL_MS = 60_000;
function useOwnWorkspaceTree(): string[] | null {
  const [files, setFiles] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    const look = () => void listWorkspaceTree()
      .then((f) => { if (alive) setFiles(f); })
      .catch(() => { /* keep last good — a blip must not flip rows back to "no brief yet" */ });
    look();
    const t = setInterval(() => { if (document.visibilityState === "visible") look(); }, OWN_TREE_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return files;
}

// ── rendering ─────────────────────────────────────────────────────────────────────────────────
const label = (m: MeetingMock) => m.title_custom ?? (m.native_id ?? m.title).replace(/^Google Meet · /, "");

function timeShort(at?: string): string {
  if (!at) return "no time set";
  try { return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
  catch { return "scheduled"; }
}

function Faces({ m }: { m: MeetingMock }) {
  const att = (m.attendees ?? []).slice(0, 3);
  if (!att.length) {
    return (
      <div style={{
        width: 22, height: 22, borderRadius: "50%", background: "var(--panel2)",
        display: "flex", alignItems: "center", justifyContent: "center", color: "var(--t3)", flex: "none"
      }}>
        <Icon name="user" size={12} />
      </div>
    );
  }
  const extra = (m.attendees?.length ?? 0) - att.length;
  const initials = (a: { email: string; name?: string }) =>
    (a.name ? a.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("") : a.email.slice(0, 2)).toUpperCase();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", flex: "none" }}>
      {att.map((a, i) => (
        <span key={a.email} title={a.name || a.email}
          style={{
            width: 22, height: 22, borderRadius: "50%", background: "var(--green)", color: "var(--on-green)",
            display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700,
            border: "2px solid var(--panel)", marginLeft: i ? -7 : 0, boxShadow: "0 1px 2px rgba(0,0,0,0.06)"
          }}>
          {initials(a)}
        </span>
      ))}
      {extra > 0 && (
        <span style={{
          width: 22, height: 22, borderRadius: "50%", background: "var(--panel2)", color: "var(--t2)",
          display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700,
          border: "2px solid var(--panel)", marginLeft: -7
        }}>+{extra}</span>
      )}
    </span>
  );
}

function EventRow({ g, ownTree }: { g: MeetingGroup; ownTree: string[] | null }) {
  const m = g.current;
  const nav = usePreviewPinTab<HTMLDivElement>(meetingTab(m));
  const hasOwnBrief = !m.workspace_id && !!ownTree
    && !!findBriefNote(ownTree, { title: label(m), nativeId: m.native_id });
  const dev = deviationPhrase(g, hasOwnBrief);
  const isLive = g.phase === "live";

  return (
    <div
      onClick={nav.onClick}
      onDoubleClick={nav.onDoubleClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "8px 12px",
        borderRadius: 8,
        cursor: "pointer",
        background: isLive ? "var(--greenbg)" : "transparent",
        border: isLive ? "1px solid var(--green)" : "1px solid transparent",
        transition: "all 0.15s ease",
      }}
      onMouseEnter={(e) => {
        if (!isLive) e.currentTarget.style.background = "var(--panel2)";
      }}
      onMouseLeave={(e) => {
        if (!isLive) e.currentTarget.style.background = "transparent";
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
        <div style={{
          width: 26,
          height: 26,
          borderRadius: 6,
          background: isLive ? "var(--green)" : "var(--panel2)",
          color: isLive ? "var(--on-green)" : "var(--t2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "none",
        }}>
          <Icon name="video" size={13} />
        </div>
        <span style={{
          fontSize: 13.5,
          fontWeight: 600,
          color: "var(--t1)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }}>
          {label(m)}
        </span>
        {dev && (
          <span style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
            fontWeight: 600,
            color: dev.tone === "live" ? "var(--green)" : dev.tone === "danger" ? "var(--danger)" : "var(--accent)",
            background: dev.tone === "live" ? "var(--greenbg)" : dev.tone === "danger" ? "var(--dangerbg)" : "var(--accentbg)",
            padding: "2px 8px",
            borderRadius: 6,
            flex: "none"
          }}>
            {dev.tone === "danger" && <Icon name="alert" size={11} />}
            {dev.text}
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "none" }}>
        <span style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "3px 8px",
          borderRadius: 6,
          background: "var(--panel2)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--t2)",
          fontWeight: 500,
        }}>
          <Icon name="clock" size={11} style={{ color: "var(--t3)" }} />
          {timeShort(m.scheduled_at)}
        </span>
      </div>
    </div>
  );
}

function DayRow({ day, isToday, ownTree }: { day: AgendaDay; isToday: boolean; ownTree: string[] | null }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "68px 1fr",
      gap: "0 16px",
      padding: "12px 16px",
      borderTop: "1px solid var(--line)",
      alignItems: "center",
    }}>
      <div style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "6px 4px",
        borderRadius: 8,
        background: isToday ? "var(--greenbg)" : "var(--panel2)",
        border: isToday ? "1px solid var(--green)" : "1px solid var(--line)",
        textAlign: "center",
      }}>
        <span style={{
          fontSize: 19,
          fontWeight: 700,
          color: isToday ? "var(--green)" : "var(--t1)",
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1
        }}>
          {day.date.getDate()}
        </span>
        <span style={{
          fontSize: 9.5,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: isToday ? "var(--green)" : "var(--t3)",
          marginTop: 3,
          lineHeight: 1
        }}>
          {day.date.toLocaleString(undefined, { month: "short" })}
        </span>
        {isToday ? (
          <span style={{
            fontSize: 8.5,
            fontWeight: 800,
            letterSpacing: "0.05em",
            color: "var(--green)",
            marginTop: 2
          }}>
            HOJE
          </span>
        ) : (
          <span style={{ fontSize: 9, color: "var(--t3)", marginTop: 2 }}>
            {day.date.toLocaleString(undefined, { weekday: "short" })}
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        {day.groups.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 8px", color: "var(--t3)", fontSize: 12.5 }}>
            <Icon name="cal" size={13} style={{ opacity: 0.6 }} />
            No events today
          </div>
        ) : (
          day.groups.map((g) => <EventRow key={g.key} g={g} ownTree={ownTree} />)
        )}
      </div>
    </div>
  );
}

function PastLine({ m }: { m: MeetingMock }) {
  const [line, setLine] = useState<string>("");
  useEffect(() => {
    let on = true;
    if (!m.has_recording) { setLine(""); return; }
    fetchDurableTranscript(m.id)
      .then((t) => {
        if (!on) return;
        if (t.notes.length) setLine(`${t.notes.length} notes`);
        else if (t.lines?.length) setLine(`${t.lines.length} lines`);
      })
      .catch(() => { });
    return () => { on = false; };
  }, [m.id, m.has_recording]);
  const dur = (() => {
    if (!m.start_time || !m.end_time) return "";
    const min = Math.round((new Date(m.end_time).getTime() - new Date(m.start_time).getTime()) / 60000);
    return min > 0 ? `${min}m` : "";
  })();
  const when = m.start_time
    ? new Date(m.start_time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  return <>{[when, dur, line].filter(Boolean).join(" · ")}</>;
}

function PastRow({ e, reviewedIds }: { e: PastEntry; reviewedIds: Set<string> }) {
  const run = e.run;
  const layout = useService(LayoutServiceId);
  const open = () => { markReviewed(run.id); layout.openTab(meetingTab(run)); };
  const unreviewed = !reviewedIds.has(run.id);
  const phrase = run.has_recording
    ? (unreviewed ? { text: "recap ready", color: "var(--green)", bg: "var(--greenbg)", icon: "spark" } : null)
    : { text: "nothing captured", color: "var(--t3)", bg: "var(--panel2)", icon: null };

  return (
    <div
      onClick={open}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 14px",
        margin: "4px 0",
        borderRadius: 9,
        background: "var(--panel)",
        border: "1px solid var(--line)",
        cursor: "pointer",
        transition: "all 0.15s ease",
        boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
      }}
      onMouseEnter={(ev) => {
        ev.currentTarget.style.background = "var(--panel2)";
        ev.currentTarget.style.borderColor = "var(--line2)";
        ev.currentTarget.style.transform = "translateX(2px)";
      }}
      onMouseLeave={(ev) => {
        ev.currentTarget.style.background = "var(--panel)";
        ev.currentTarget.style.borderColor = "var(--line)";
        ev.currentTarget.style.transform = "none";
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
        <Faces m={run.attendees?.length ? run : e.group.current} />
        <span style={{
          fontSize: 13.5,
          fontWeight: 600,
          color: "var(--t1)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }}>
          {label(run)}
        </span>
        {phrase && (
          <span style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
            fontWeight: 600,
            color: phrase.color,
            background: phrase.bg,
            padding: "2px 8px",
            borderRadius: 6,
            flex: "none",
          }}>
            {phrase.icon && <Icon name={phrase.icon} size={11} />}
            {phrase.text}
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "none" }}>
        <span style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "3px 9px",
          borderRadius: 6,
          background: "var(--panel2)",
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          color: "var(--t2)",
          fontWeight: 500,
        }}>
          <Icon name="clock" size={11} style={{ color: "var(--t3)" }} />
          <PastLine m={run} />
        </span>
      </div>
    </div>
  );
}

// ── the tab ───────────────────────────────────────────────────────────────────────────────────
function TodayView() {
  const meetings = useLiveMeetings();
  const reviewedIds = useReviewed();
  const ownTree = useOwnWorkspaceTree();
  const [weekOffset, setWeekOffset] = useState(0);
  const now = new Date();
  const groups = groupMeetings(meetings);
  const days = agendaWindow(groups, now, weekOffset);
  const past = pastFeed(groups);
  const todayKey = dayKey(now);
  const empty = meetings.length === 0;
  const pager = {
    background: "var(--panel)", border: "1px solid var(--line2)", color: "var(--t2)", borderRadius: 6,
    width: 26, height: 26, cursor: "pointer", fontSize: 13, lineHeight: 1, display: "inline-flex",
    alignItems: "center", justifyContent: "center", transition: "background 0.15s ease"
  } as const;

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "24px 28px" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8, background: "var(--greenbg)",
              color: "var(--green)", display: "flex", alignItems: "center", justifyContent: "center"
            }}>
              <Icon name="cal" size={16} />
            </div>
            <span style={{ fontSize: 18, fontWeight: 700, color: "var(--t1)", letterSpacing: "-0.01em" }}>
              A seguir
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {weekOffset > 0 && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--t3)", padding: "0 6px" }}>
                {days[0]?.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) ?? ""} →
              </span>
            )}
            <button
              aria-label="previous week"
              style={{ ...pager, opacity: weekOffset === 0 ? 0.35 : 1 }}
              disabled={weekOffset === 0}
              onClick={() => setWeekOffset((v) => Math.max(0, v - 1))}
            >
              ‹
            </button>
            <button
              aria-label="next week"
              style={pager}
              onClick={() => setWeekOffset((v) => Math.min(8, v + 1))}
            >
              ›
            </button>
          </div>
        </div>

        {empty ? (
          <MeetingsOnboarding variant="full" />
        ) : (
          <>
            <MeetingsOnboarding variant="slim" />
            <div style={{
              marginTop: 14,
              border: "1px solid var(--line)",
              borderRadius: 12,
              background: "var(--panel)",
              overflow: "hidden",
              boxShadow: "0 1px 3px rgba(0,0,0,0.02)"
            }}>
              {days.length === 0
                ? <div style={{ padding: "16px 18px", fontSize: 12.5, color: "var(--t3)" }}>Nothing this week.</div>
                : days.map((d) => <DayRow key={d.key} day={d} isToday={d.key === todayKey} ownTree={ownTree} />)}
            </div>
          </>
        )}

        {past.length > 0 && (
          <div style={{ marginTop: 28 }}>
            {past.map((day) => (
              <div key={day.key} style={{ marginBottom: 16 }}>
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  margin: "18px 0 8px"
                }}>
                  <span style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: ".05em",
                    textTransform: "uppercase",
                    color: "var(--t3)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6
                  }}>
                    <Icon name="cal" size={12} />
                    {day.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                  </span>
                  <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
                </div>
                {day.entries.map((e) => <PastRow key={e.run.id} e={e} reviewedIds={reviewedIds} />)}
              </div>
            ))}
          </div>
        )}

        {!empty && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 16px",
            borderRadius: 8,
            background: "var(--panel)",
            border: "1px solid var(--line)",
            fontSize: 12,
            color: "var(--t3)",
            margin: "28px 0 16px",
            lineHeight: 1.5
          }}>
            <Icon name="info" size={15} style={{ color: "var(--t2)", flex: "none" }} />
            <span>
              Reuniões anteriores ficam armazenadas na Base de Conhecimento — pergunte ao agente sobre qualquer coisa que tenha sido dita ou decidida.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

registerTab("today", TodayView);
