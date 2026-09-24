"use client";
/** MeetingSummaryView — Native AI Meeting Recap & Executive Summary (Ata de Reunião).
 *  Renders the structured knowledge-graph meeting document (`kg/entities/meeting/<native>.md`),
 *  along with key decisions, action items, participants, and one-click AI generation / refresh. */

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Icon, Checkbox } from "../ui-kit";
import { Markdown } from "../ui-kit/Markdown";
import { copyText } from "../ui-kit/ContextMenu";
import { OPEN_ENTITY_EVENT } from "./actions";
import { useEntities, useMeeting, useSignals, useSpeakers, useTranscript } from "./useMeeting";
import { useMeetingNotes } from "./notes";
import type { TranscriptSegment } from "./types";

interface MeetingSummaryDoc {
  status: "loading" | "absent" | "present";
  rawContent: string;
  title: string;
  date?: string;
  summary: string;
  decisions: string[];
  actions: { text: string; done: boolean }[];
  attendees: string[];
  topics: string[];
  hasGenerated: boolean;
}

const EMPTY_DOC: MeetingSummaryDoc = {
  status: "loading",
  rawContent: "",
  title: "",
  summary: "",
  decisions: [],
  actions: [],
  attendees: [],
  topics: [],
  hasGenerated: false,
};

function parseMeetingMarkdown(content: string, fallbackTitle: string): MeetingSummaryDoc {
  // Extract YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = fmMatch ? fmMatch[1] : "";
  const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content.trim();

  // Frontmatter fields
  const titleLine = frontmatter.split("\n").find((l) => l.startsWith("title:"))?.slice(6).trim();
  const dateLine = frontmatter.split("\n").find((l) => l.startsWith("date:"))?.slice(5).trim();
  const title = (titleLine || fallbackTitle).replace(/^["']|["']$/g, "");

  // Parse sections
  const sections = body.split(/^##\s+/m);
  let summary = "";
  const decisions: string[] = [];
  const actions: { text: string; done: boolean }[] = [];
  const attendees: string[] = [];
  const topics: string[] = [];

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i].trim();
    if (!sec) continue;

    if (i === 0 && !body.startsWith("##")) {
      // Leading text before first ## heading is the executive summary
      const cleanIntro = sec.replace(/^#\s+.+$/m, "").replace(/^>.*$/gm, "").trim();
      if (cleanIntro) summary = cleanIntro;
      continue;
    }

    const firstLineEnd = sec.indexOf("\n");
    const heading = (firstLineEnd === -1 ? sec : sec.slice(0, firstLineEnd)).toLowerCase().trim();
    const secBody = firstLineEnd === -1 ? "" : sec.slice(firstLineEnd).trim();

    if (heading.includes("summary") || heading.includes("resumo") || heading.includes("contexto") || heading.includes("overview")) {
      if (!summary) summary = secBody;
    } else if (heading.includes("decision") || heading.includes("decis")) {
      const items = secBody.split("\n").map((l) => l.replace(/^[-*•]\s+/, "").trim()).filter(Boolean);
      decisions.push(...items);
    } else if (heading.includes("action") || heading.includes("ação") || heading.includes("tarefa") || heading.includes("próximos passos")) {
      const items = secBody.split("\n").map((l) => {
        const line = l.trim();
        const done = /^[-*•]\s*\[x\]/i.test(line);
        const text = line.replace(/^[-*•]\s*\[[ xX]\]\s*/, "").replace(/^[-*•]\s+/, "").trim();
        return text ? { text, done } : null;
      }).filter((a): a is { text: string; done: boolean } => a !== null);
      actions.push(...items);
    } else if (heading.includes("attendee") || heading.includes("participante") || heading.includes("presente")) {
      const items = secBody.split("\n").map((l) => l.replace(/^[-*•]\s+/, "").trim()).filter(Boolean);
      attendees.push(...items);
    } else if (heading.includes("topic") || heading.includes("tópico") || heading.includes("pauta") || heading.includes("discuss")) {
      const items = secBody.split("\n").map((l) => l.replace(/^[-*•]\s+/, "").trim()).filter(Boolean);
      topics.push(...items);
    }
  }

  return {
    status: "present",
    rawContent: content,
    title,
    date: dateLine,
    summary: summary || body,
    decisions,
    actions,
    attendees,
    topics,
    hasGenerated: true,
  };
}

export function MeetingSummaryView({ meetingId }: { meetingId?: string }) {
  const { meeting, transcript } = useMeeting(meetingId);
  const notes = useMeetingNotes();
  const entities = useEntities();
  const signals = useSignals();
  const speakers = useSpeakers();
  const { segments } = useTranscript();

  const [doc, setDoc] = useState<MeetingSummaryDoc>(EMPTY_DOC);
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genStatusText, setGenStatusText] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const nativeId = meeting.nativeId || meetingId || "meeting";
  const displayTitle = meeting.title || `Reunião ${nativeId}`;

  // Fetch the knowledge graph meeting entity document (or cached summary)
  const loadDoc = useCallback(async () => {
    if (!nativeId) return;

    // 1. Try local cache first for instant hydration
    if (typeof window !== "undefined") {
      try {
        const cached = localStorage.getItem(`vexa_ata_${nativeId}`);
        if (cached && cached.length > 50) {
          const parsed = parseMeetingMarkdown(cached, displayTitle);
          setDoc(parsed);
          return;
        }
      } catch { /* ignore */ }
    }

    // 2. Fetch workspace file
    try {
      const path = `kg/entities/meeting/${nativeId}.md`;
      const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.content && data.content.length > 50) {
          const parsed = parseMeetingMarkdown(data.content, displayTitle);
          setDoc(parsed);
          return;
        }
      }
      setDoc((prev) => ({ ...prev, status: "absent", title: displayTitle }));
    } catch {
      setDoc((prev) => ({ ...prev, status: "absent", title: displayTitle }));
    }
  }, [nativeId, displayTitle]);

  useEffect(() => {
    void loadDoc();
  }, [loadDoc]);

  // Aggregate signals into fallback decisions/actions if no formal markdown file exists yet
  const fallbackDecisions = useMemo(() => {
    return signals.filter((s) => s.context?.toLowerCase().includes("decis") || (s.kind as string) === "decision");
  }, [signals]);

  const fallbackActions = useMemo(() => {
    return signals.filter((s) => s.context?.toLowerCase().includes("action") || s.context?.toLowerCase().includes("task") || (s.kind as string) === "action");
  }, [signals]);

  const isPresent = doc.status === "present" && (doc.summary.length > 0 || doc.decisions.length > 0 || doc.actions.length > 0);
  const autoTriggeredRef = useRef(false);

  // Trigger AI Meeting Recap Generation natively via /api/meeting/summarize (never touches chat)
  const handleGenerateRecap = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    setErrorMsg(null);
    setGenStatusText("Processando transcrição e sintetizando ata executiva com IA…");

    try {
      const res = await fetch("/api/meeting/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meeting_id: meetingId,
          native_id: nativeId,
          title: displayTitle,
          segments,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Falha na requisição (${res.status})`);
      }

      const data = await res.json();
      if (data.content) {
        const parsed = parseMeetingMarkdown(data.content, displayTitle);
        setDoc(parsed);
        if (typeof window !== "undefined") {
          try {
            localStorage.setItem(`vexa_ata_${nativeId}`, data.content);
          } catch { /* ignore */ }
        }
      } else {
        throw new Error("Resposta da IA vazia");
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Falha ao sintetizar ata com IA");
    } finally {
      setGenerating(false);
      setGenStatusText("");
    }
  }, [displayTitle, generating, meetingId, nativeId, segments]);

  const isTerminal = ["completed", "failed", "stopped", "past"].includes(meeting.status ?? "");
  const isLive = meeting.live === true && !isTerminal;

  // AUTOMATIC PROCESSING: Only trigger AI recap when meeting is COMPLETED (never during live call)
  useEffect(() => {
    if (isTerminal && doc.status === "absent" && !isPresent && !generating && !autoTriggeredRef.current) {
      if (segments.length > 0 || notes.length > 0) {
        autoTriggeredRef.current = true;
        void handleGenerateRecap();
      }
    }
  }, [isTerminal, doc.status, isPresent, generating, segments.length, notes.length, handleGenerateRecap]);

  // Copy full ata to clipboard
  const handleCopyAta = async () => {
    let textToCopy = doc.rawContent;
    if (!textToCopy || doc.status !== "present") {
      // Build text from structured data
      textToCopy = [
        `# Ata de Reunião: ${displayTitle}`,
        `Data: ${doc.date || new Date().toLocaleDateString("pt-BR")}`,
        "",
        "## Participantes",
        speakers.map((s) => `- ${s.name}`).join("\n") || "- Nenhum registrado",
        "",
        "## Resumo Executivo",
        doc.summary || "Reunião finalizada.",
        "",
        "## Decisões Tomadas",
        (doc.decisions.length ? doc.decisions : fallbackDecisions.map((d) => d.name)).map((d) => `- ${d}`).join("\n") || "- Nenhuma decisão formal registrada",
        "",
        "## Próximos Passos & Ações",
        (doc.actions.length ? doc.actions.map((a) => `- [${a.done ? "x" : " "}] ${a.text}`) : fallbackActions.map((a) => `- [ ] ${a.name}`)).join("\n") || "- Nenhuma ação pendente",
      ].join("\n");
    }

    await copyText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  };

  const openDocTab = () => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(OPEN_ENTITY_EVENT, {
          detail: { path: `kg/entities/meeting/${nativeId}.md`, wikilink: displayTitle },
        }),
      );
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, width: "100%", maxWidth: 960, margin: "0 auto", paddingBottom: 40 }}>
      {isLive && (
        <div
          style={{
            background: "var(--panel2)",
            border: "1px dashed var(--blue)",
            borderRadius: 12,
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12.5,
            color: "var(--t1)",
            boxShadow: "0 2px 10px rgba(0,0,0,0.1)",
          }}
        >
          <Icon name="msg" size={16} style={{ color: "var(--blue)", flex: "none" }} />
          <div>
            <span style={{ fontWeight: 650, color: "var(--blue)" }}>Reunião em andamento:</span> As falas estão sendo transcritas pelo Whisper. A ata executiva oficial com resumo, decisões e próximos passos será sintetizada pela IA automaticamente assim que a chamada for encerrada.
          </div>
        </div>
      )}

      {/* Top Header Card */}
      <div
        style={{
          background: "var(--panel)",
          border: "1px solid var(--line2)",
          borderRadius: 12,
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "var(--violetbg)",
                color: "var(--violet)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="spark" size={18} />
            </span>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650, color: "var(--t1)" }}>
                  Ata & Resumo Executivo da Reunião
                </h2>
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: ".05em",
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: isPresent ? "var(--greenbg)" : "var(--warnbg)",
                    color: isPresent ? "var(--green)" : "var(--warn)",
                  }}
                >
                  {isPresent ? "Ata Oficial IA" : "Síntese Preliminar"}
                </span>
              </div>
              <div style={{ fontSize: 12, color: "var(--t3)", marginTop: 2 }}>
                {displayTitle} • ID: <code style={{ fontFamily: "var(--mono)", color: "var(--t2)" }}>{nativeId}</code>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={handleCopyAta}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                borderRadius: 8,
                background: copied ? "var(--greenbg)" : "var(--panel2)",
                color: copied ? "var(--green)" : "var(--t1)",
                border: `1px solid ${copied ? "var(--green)" : "var(--line2)"}`,
                fontSize: 12,
                fontWeight: 550,
                cursor: "pointer",
                transition: "all .15s ease",
              }}
            >
              <Icon name={copied ? "check" : "copy"} size={13} />
              {copied ? "Ata Copiada!" : "Copiar Ata"}
            </button>

            <button
              type="button"
              disabled={generating}
              onClick={handleGenerateRecap}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 14px",
                borderRadius: 8,
                background: "var(--accent)",
                color: "var(--on-accent)",
                border: "none",
                fontSize: 12,
                fontWeight: 650,
                cursor: generating ? "not-allowed" : "pointer",
                opacity: generating ? 0.6 : 1,
                boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
              }}
            >
              <Icon name="refresh" size={13} style={{ animation: generating ? "spin 1s linear infinite" : "none" }} />
              {isPresent ? "Atualizar Ata com IA" : "Gerar Ata com IA"}
            </button>

            {isPresent && (
              <button
                type="button"
                onClick={openDocTab}
                title="Abrir arquivo markdown no workspace"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "6px 10px",
                  borderRadius: 8,
                  background: "transparent",
                  color: "var(--t2)",
                  border: "1px solid var(--line2)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                <Icon name="openIn" size={13} />
                Doc
              </button>
            )}
          </div>
        </div>

        {/* Quick Highlights Counter */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 8,
            paddingTop: 8,
            borderTop: "1px solid var(--line)",
          }}
        >
          <div style={{ background: "var(--panel2)", borderRadius: 8, padding: "8px 12px" }}>
            <div style={{ fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".04em" }}>Participantes</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--blue)", marginTop: 2 }}>
              {doc.attendees.length || speakers.length || 1}
            </div>
          </div>
          <div style={{ background: "var(--panel2)", borderRadius: 8, padding: "8px 12px" }}>
            <div style={{ fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".04em" }}>Decisões</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--violet)", marginTop: 2 }}>
              {doc.decisions.length || fallbackDecisions.length}
            </div>
          </div>
          <div style={{ background: "var(--panel2)", borderRadius: 8, padding: "8px 12px" }}>
            <div style={{ fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".04em" }}>Ações & Tarefas</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--green)", marginTop: 2 }}>
              {doc.actions.length || fallbackActions.length}
            </div>
          </div>
          <div style={{ background: "var(--panel2)", borderRadius: 8, padding: "8px 12px" }}>
            <div style={{ fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".04em" }}>Falas Transcritas</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--t1)", marginTop: 2 }}>
              {segments.length}
            </div>
          </div>
        </div>

        {generating && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              borderRadius: 8,
              background: "var(--accentbg)",
              color: "var(--accent)",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <Icon name="spark" size={14} />
            {genStatusText}
          </div>
        )}

        {errorMsg && (
          <div
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              background: "var(--dangerbg)",
              color: "var(--danger)",
              fontSize: 12,
            }}
          >
            ⚠️ {errorMsg}
          </div>
        )}
      </div>

      {/* Main Content Layout */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Executive Summary Section */}
        <div
          style={{
            background: "var(--panel)",
            border: "1px solid var(--line)",
            borderRadius: 12,
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--accent)", fontWeight: 650, fontSize: 13.5 }}>
            <Icon name="file" size={16} />
            <span>Resumo Executivo & Contexto</span>
          </div>

          <div style={{ fontSize: 13.5, color: "var(--t1)", lineHeight: 1.65 }}>
            {doc.summary ? (
              <Markdown>{doc.summary}</Markdown>
            ) : notes.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {notes.map((n) => (
                  <div key={n.id} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span style={{ fontWeight: 600, color: "var(--accent)", fontSize: 12.5, flex: "none" }}>{n.speaker}:</span>
                    <span style={{ color: "var(--t1)" }}>{n.text}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: "var(--t3)", fontStyle: "italic", padding: "8px 0" }}>
                Nenhum resumo formal foi compilado ainda. Clique no botão &quot;Gerar Ata com IA&quot; acima para processar toda a transcrição e extrair a ata completa.
              </div>
            )}
          </div>
        </div>

        {/* Two Column Grid: Decisions & Actions */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16 }}>
          {/* Key Decisions */}
          <div
            style={{
              background: "var(--panel)",
              border: "1px solid var(--line)",
              borderRadius: 12,
              padding: 20,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--violet)", fontWeight: 650, fontSize: 13.5 }}>
                <Icon name="check" size={16} />
                <span>Decisões Tomadas</span>
              </div>
              <span style={{ fontSize: 11, color: "var(--violet)", background: "var(--violetbg)", padding: "1px 7px", borderRadius: 999, fontWeight: 600 }}>
                {doc.decisions.length || fallbackDecisions.length}
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {doc.decisions.length > 0 ? (
                doc.decisions.map((dec, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "10px 12px",
                      borderRadius: 8,
                      background: "var(--panel2)",
                      border: "1px solid var(--line2)",
                      fontSize: 13,
                      color: "var(--t1)",
                      lineHeight: 1.45,
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--violet)", marginTop: 6, flex: "none" }} />
                    <div style={{ flex: 1 }}>
                      <Markdown>{dec}</Markdown>
                    </div>
                  </div>
                ))
              ) : fallbackDecisions.length > 0 ? (
                fallbackDecisions.map((sig) => (
                  <div
                    key={sig.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "10px 12px",
                      borderRadius: 8,
                      background: "var(--panel2)",
                      border: "1px solid var(--line2)",
                      fontSize: 13,
                      color: "var(--t1)",
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--violet)", marginTop: 6, flex: "none" }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 550 }}>{sig.name}</div>
                      {sig.summary && <div style={{ fontSize: 12, color: "var(--t2)", marginTop: 2 }}>{sig.summary}</div>}
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ fontSize: 12.5, color: "var(--t3)", fontStyle: "italic", padding: "6px 0" }}>
                  Nenhuma decisão formal foi registrada.
                </div>
              )}
            </div>
          </div>

          {/* Action Items & Next Steps */}
          <div
            style={{
              background: "var(--panel)",
              border: "1px solid var(--line)",
              borderRadius: 12,
              padding: 20,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--green)", fontWeight: 650, fontSize: 13.5 }}>
                <Icon name="tasks" size={16} />
                <span>Próximos Passos & Tarefas</span>
              </div>
              <span style={{ fontSize: 11, color: "var(--green)", background: "var(--greenbg)", padding: "1px 7px", borderRadius: 999, fontWeight: 600 }}>
                {doc.actions.length || fallbackActions.length}
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {doc.actions.length > 0 ? (
                doc.actions.map((act, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "10px 12px",
                      borderRadius: 8,
                      background: "var(--panel2)",
                      border: "1px solid var(--line2)",
                      fontSize: 13,
                      color: "var(--t1)",
                      lineHeight: 1.45,
                    }}
                  >
                    <Checkbox checked={act.done} size={15} />
                    <div style={{ flex: 1, textDecoration: act.done ? "line-through" : "none", opacity: act.done ? 0.6 : 1 }}>
                      <Markdown>{act.text}</Markdown>
                    </div>
                  </div>
                ))
              ) : fallbackActions.length > 0 ? (
                fallbackActions.map((act) => (
                  <div
                    key={act.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "10px 12px",
                      borderRadius: 8,
                      background: "var(--panel2)",
                      border: "1px solid var(--line2)",
                      fontSize: 13,
                      color: "var(--t1)",
                    }}
                  >
                    <Checkbox checked={false} size={15} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 550 }}>{act.name}</div>
                      {act.summary && <div style={{ fontSize: 12, color: "var(--t2)", marginTop: 2 }}>{act.summary}</div>}
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ fontSize: 12.5, color: "var(--t3)", fontStyle: "italic", padding: "6px 0" }}>
                  Nenhuma tarefa ou ação pendente foi identificada.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Topics and Attendees Grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16 }}>
          {/* Topics */}
          <div
            style={{
              background: "var(--panel)",
              border: "1px solid var(--line)",
              borderRadius: 12,
              padding: 20,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--blue)", fontWeight: 650, fontSize: 13.5 }}>
              <Icon name="tag" size={16} />
              <span>Tópicos & Pautas Abordadas</span>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {doc.topics.length > 0 ? (
                doc.topics.map((t, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 8,
                      background: "var(--panel2)",
                      border: "1px solid var(--line2)",
                      fontSize: 12.5,
                      color: "var(--t1)",
                    }}
                  >
                    <Markdown>{t}</Markdown>
                  </div>
                ))
              ) : (
                <div style={{ fontSize: 12.5, color: "var(--t3)", fontStyle: "italic" }}>
                  Tópicos gerais da pauta em discussão.
                </div>
              )}
            </div>
          </div>

          {/* Attendees & Mentioned Entities */}
          <div
            style={{
              background: "var(--panel)",
              border: "1px solid var(--line)",
              borderRadius: 12,
              padding: 20,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--t1)", fontWeight: 650, fontSize: 13.5 }}>
              <Icon name="user" size={16} />
              <span>Participantes & Menções na Reunião</span>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {speakers.length > 0 ? (
                speakers.map((sp) => (
                  <div
                    key={sp.name}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 7,
                      padding: "5px 10px",
                      borderRadius: 8,
                      background: "var(--panel2)",
                      border: "1px solid var(--line)",
                      fontSize: 12.5,
                      color: "var(--t1)",
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)" }} />
                    <span style={{ fontWeight: 550 }}>{sp.name}</span>
                    {sp.talkPct > 0 && <span style={{ fontSize: 11, color: "var(--t3)" }}>{sp.talkPct}%</span>}
                  </div>
                ))
              ) : (
                entities.map((e) => (
                  <div
                    key={e.id}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 7,
                      padding: "5px 10px",
                      borderRadius: 8,
                      background: "var(--panel2)",
                      border: "1px solid var(--line)",
                      fontSize: 12.5,
                      color: "var(--t1)",
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--blue)" }} />
                    <span>{e.name}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
