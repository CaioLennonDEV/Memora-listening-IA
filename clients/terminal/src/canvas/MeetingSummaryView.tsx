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

type SectionType = "none" | "summary" | "attendees" | "decisions" | "actions" | "topics";

function detectSectionHeading(rawLine: string): SectionType | null {
  const line = rawLine.trim();
  if (!line) return null;
  // Remove markdown heading marks (#, ##, ###), bold/italic marks, trailing colons
  const clean = line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*+|\*+$/g, "")
    .replace(/^_+|_+$/g, "")
    .replace(/:$/, "")
    .trim()
    .toLowerCase();

  if (/^(participantes|participante|attendees|presentes|participantes presentes|participantes & menções|participantes e menções|membros)/i.test(clean)) {
    return "attendees";
  }
  if (/^(resumo|resumo executivo|contexto|overview|introdução|introducao|síntese|sintese|sumário|sumario)/i.test(clean)) {
    return "summary";
  }
  if (/^(decisões|decisoes|decisões tomadas|decisoes tomadas|deliberações|deliberacoes|decisions|acordos)/i.test(clean)) {
    return "decisions";
  }
  if (/^(ações|acoes|ações & tarefas|ações e tarefas|ações recomendadas|tarefas|ações pendentes|próximos passos|proximos passos|próximos passos & tarefas|itens de atenção|itens de atencao|itens de atenção \/ próximos passos|actions|next steps|follow-up|pendências|pendencias)/i.test(clean)) {
    return "actions";
  }
  if (/^(tópicos|topicos|tópicos & pautas|pautas|principais tópicos|principais temas|principais pontos|principais pontos observados|pontos observados|pontos discutidos|discussão|discussao|topics|pauta)/i.test(clean)) {
    return "topics";
  }
  return null;
}

function parseMeetingMarkdown(content: string, fallbackTitle: string): MeetingSummaryDoc {
  if (!content || !content.trim()) {
    return { ...EMPTY_DOC, title: fallbackTitle };
  }

  // Extract YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = fmMatch ? fmMatch[1] : "";
  const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content.trim();

  // Frontmatter fields
  const titleLine = frontmatter.split("\n").find((l) => l.startsWith("title:"))?.slice(6).trim();
  const dateLine = frontmatter.split("\n").find((l) => l.startsWith("date:"))?.slice(5).trim();
  const title = (titleLine || fallbackTitle).replace(/^["']|["']$/g, "");

  const summaryLines: string[] = [];
  const decisions: string[] = [];
  const actions: { text: string; done: boolean }[] = [];
  const attendees: string[] = [];
  const topics: string[] = [];

  const lines = body.split("\n");
  let currentSection: SectionType = "none";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (currentSection === "summary") {
        summaryLines.push("");
      }
      continue;
    }

    // Check if this line is a heading
    const detected = detectSectionHeading(rawLine);
    if (detected !== null) {
      currentSection = detected;
      continue;
    }

    // Process line based on current section
    if (currentSection === "attendees") {
      const cleanItem = line.replace(/^[-*•\d.]+\s+/, "").trim();
      if (cleanItem) attendees.push(cleanItem);
    } else if (currentSection === "decisions") {
      const cleanItem = line.replace(/^[-*•\d.]+\s+/, "").trim();
      if (cleanItem) decisions.push(cleanItem);
    } else if (currentSection === "actions") {
      const done = /^[-*•]\s*\[x\]/i.test(line);
      const text = line.replace(/^[-*•]\s*\[[ xX]\]\s*/, "").replace(/^[-*•\d.]+\s+/, "").trim();
      if (text) actions.push({ text, done });
    } else if (currentSection === "topics") {
      const cleanItem = line.replace(/^[-*•\d.]+\s+/, "").trim();
      if (cleanItem) topics.push(cleanItem);
    } else if (currentSection === "summary") {
      summaryLines.push(line);
    } else {
      // none: could be title or introductory paragraph
      if (line.startsWith("#")) {
        // title line, ignore
      } else {
        summaryLines.push(line);
      }
    }
  }

  const summary = summaryLines.join("\n").trim();

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

  const nativeId = meeting.nativeId || (meeting as unknown as { native_id?: string }).native_id || meetingId || "meeting";
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

    // 2. Fetch workspace file (only if it exists in the workspace tree)
    try {
      const treeRes = await fetch(`/api/workspace/tree`);
      if (treeRes.ok) {
        const treeData = await treeRes.json();
        const files: string[] = treeData.files ?? [];
        const path = `kg/entities/meeting/${nativeId}.md`;
        if (files.includes(path)) {
          const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`);
          if (res.ok) {
            const data = await res.json();
            if (data.content && data.content.length > 50) {
              const parsed = parseMeetingMarkdown(data.content, displayTitle);
              setDoc(parsed);
              return;
            }
          }
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

  // Trigger AI Meeting Recap Generation natively via /api/meeting/summarize
  const handleGenerateRecap = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    setErrorMsg(null);
    setGenStatusText("Processando transcrição e sintetizando ata executiva com IA…");

    try {
      // Prepare transcript text from all available sources
      let payloadTranscript = "";
      const allSegments = segments.length > 0 ? segments : (transcript?.segments || []);
      if (allSegments && allSegments.length > 0) {
        payloadTranscript = allSegments
          .map((s) => `${s.speaker || "Participante"}: ${s.text || ""}`)
          .join("\n");
      } else if (notes && notes.length > 0) {
        payloadTranscript = notes
          .map((n) => `${n.speaker || "Participante"}: ${n.text || ""}`)
          .join("\n");
      }

      const res = await fetch("/api/meeting/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meeting_id: meetingId,
          native_id: nativeId,
          title: displayTitle,
          transcript: payloadTranscript,
          segments: allSegments,
          notes,
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
  }, [displayTitle, generating, meetingId, nativeId, notes, segments, transcript]);

  const isTerminal = ["completed", "failed", "stopped", "past"].includes(meeting.status ?? "");
  const isLive = meeting.live === true && !isTerminal;

  // AUTOMATIC PROCESSING: Trigger AI recap when meeting is COMPLETED if absent
  useEffect(() => {
    if (isTerminal && doc.status === "absent" && !isPresent && !generating && !autoTriggeredRef.current) {
      if (segments.length > 0 || notes.length > 0 || ((transcript?.segments?.length ?? 0) > 0)) {
        autoTriggeredRef.current = true;
        void handleGenerateRecap();
      }
    }
  }, [isTerminal, doc.status, isPresent, generating, segments.length, notes.length, transcript?.segments?.length, handleGenerateRecap]);

  // Copy full ata to clipboard
  const handleCopyAta = async () => {
    let textToCopy = doc.rawContent;
    if (!textToCopy || doc.status !== "present") {
      textToCopy = [
        `# Ata de Reunião: ${displayTitle}`,
        `Data: ${doc.date || new Date().toLocaleDateString("pt-BR")}`,
        "",
        "## Participantes",
        (doc.attendees.length ? doc.attendees : speakers.map((s) => s.name)).map((p) => `- ${p}`).join("\n") || "- Nenhum registrado",
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

  const totalAttendeesCount = doc.attendees.length || speakers.length || entities.length || 1;
  const totalDecisionsCount = doc.decisions.length || fallbackDecisions.length;
  const totalActionsCount = doc.actions.length || fallbackActions.length;
  const totalSegmentsCount = segments.length || (transcript?.segments?.length ?? 0);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 20,
        width: "100%",
        maxWidth: 1100,
        margin: "0 auto",
        padding: "0 16px 40px",
        boxSizing: "border-box",
      }}
    >
      {/* Left Floating Sidebar — Indicators / Metrics */}
      <aside
        style={{
          width: 240,
          minWidth: 240,
          maxWidth: 260,
          position: "sticky",
          top: 0,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          flex: "none",
        }}
      >
        <div
          style={{
            background: "var(--panel)",
            border: "1px solid var(--line2)",
            borderRadius: 14,
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            boxShadow: "0 4px 20px rgba(0,0,0,0.06)",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--t3)",
              textTransform: "uppercase",
              letterSpacing: ".06em",
              paddingLeft: 2,
            }}
          >
            Indicadores
          </div>

          {/* Participantes */}
          <div
            style={{
              background: "var(--panel2)",
              borderRadius: 10,
              padding: "10px 12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              border: "1px solid var(--line)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: "var(--bluebg)",
                  color: "var(--blue)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flex: "none",
                }}
              >
                <Icon name="user" size={15} />
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 650, color: "var(--t1)" }}>Participantes</div>
                <div style={{ fontSize: 10, color: "var(--t3)" }}>na chamada</div>
              </div>
            </div>
            <span style={{ fontSize: 15, fontWeight: 750, color: "var(--blue)" }}>
              {totalAttendeesCount}
            </span>
          </div>

          {/* Decisões */}
          <div
            style={{
              background: "var(--panel2)",
              borderRadius: 10,
              padding: "10px 12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              border: "1px solid var(--line)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: "var(--violetbg)",
                  color: "var(--violet)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flex: "none",
                }}
              >
                <Icon name="check" size={15} />
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 650, color: "var(--t1)" }}>Decisões</div>
                <div style={{ fontSize: 10, color: "var(--t3)" }}>registradas</div>
              </div>
            </div>
            <span style={{ fontSize: 15, fontWeight: 750, color: "var(--violet)" }}>
              {totalDecisionsCount}
            </span>
          </div>

          {/* Ações & Tarefas */}
          <div
            style={{
              background: "var(--panel2)",
              borderRadius: 10,
              padding: "10px 12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              border: "1px solid var(--line)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: "var(--greenbg)",
                  color: "var(--green)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flex: "none",
                }}
              >
                <Icon name="tasks" size={15} />
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 650, color: "var(--t1)" }}>Ações & Tarefas</div>
                <div style={{ fontSize: 10, color: "var(--t3)" }}>próximos passos</div>
              </div>
            </div>
            <span style={{ fontSize: 15, fontWeight: 750, color: "var(--green)" }}>
              {totalActionsCount}
            </span>
          </div>

          {/* Falas Transcritas */}
          <div
            style={{
              background: "var(--panel2)",
              borderRadius: 10,
              padding: "10px 12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              border: "1px solid var(--line)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: "var(--panel)",
                  color: "var(--t2)",
                  border: "1px solid var(--line2)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flex: "none",
                }}
              >
                <Icon name="msg" size={15} />
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 650, color: "var(--t1)" }}>Falas Transcritas</div>
                <div style={{ fontSize: 10, color: "var(--t3)" }}>segmentos</div>
              </div>
            </div>
            <span style={{ fontSize: 15, fontWeight: 750, color: "var(--t1)" }}>
              {totalSegmentsCount}
            </span>
          </div>
        </div>
      </aside>

      {/* Right Column: Stacked Content Cards */}
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
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
              boxShadow: "0 2px 10px rgba(0,0,0,0.06)",
            }}
          >
            <Icon name="msg" size={16} style={{ color: "var(--blue)", flex: "none" }} />
            <div>
              <span style={{ fontWeight: 650, color: "var(--blue)" }}>Reunião em andamento:</span> As falas estão sendo transcritas pelo Whisper. A ata executiva oficial com decisões e próximos passos será sintetizada pela IA automaticamente assim que a chamada for encerrada.
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
            boxShadow: "0 4px 20px rgba(0,0,0,0.06)",
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
                  boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
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

        {/* Card: Decisões Tomadas */}
        <div
          style={{
            background: "var(--panel)",
            border: "1px solid var(--line)",
            borderRadius: 12,
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            boxShadow: "0 2px 10px rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--violet)", fontWeight: 650, fontSize: 13.5 }}>
              <Icon name="check" size={16} />
              <span>Decisões Tomadas</span>
            </div>
            <span style={{ fontSize: 11, color: "var(--violet)", background: "var(--violetbg)", padding: "1px 7px", borderRadius: 999, fontWeight: 600 }}>
              {totalDecisionsCount}
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

        {/* Card: Próximos Passos & Tarefas */}
        <div
          style={{
            background: "var(--panel)",
            border: "1px solid var(--line)",
            borderRadius: 12,
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            boxShadow: "0 2px 10px rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--green)", fontWeight: 650, fontSize: 13.5 }}>
              <Icon name="tasks" size={16} />
              <span>Próximos Passos & Tarefas</span>
            </div>
            <span style={{ fontSize: 11, color: "var(--green)", background: "var(--greenbg)", padding: "1px 7px", borderRadius: 999, fontWeight: 600 }}>
              {totalActionsCount}
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

        {/* Card: Tópicos & Pautas Abordadas */}
        <div
          style={{
            background: "var(--panel)",
            border: "1px solid var(--line)",
            borderRadius: 12,
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            boxShadow: "0 2px 10px rgba(0,0,0,0.04)",
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

        {/* Card: Participantes & Menções na Reunião */}
        <div
          style={{
            background: "var(--panel)",
            border: "1px solid var(--line)",
            borderRadius: 12,
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            boxShadow: "0 2px 10px rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--t1)", fontWeight: 650, fontSize: 13.5 }}>
            <Icon name="user" size={16} />
            <span>Participantes & Menções na Reunião</span>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {doc.attendees.length > 0 ? (
              doc.attendees.map((att, i) => (
                <div
                  key={i}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "6px 12px",
                    borderRadius: 8,
                    background: "var(--panel2)",
                    border: "1px solid var(--line)",
                    fontSize: 12.5,
                    color: "var(--t1)",
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)" }} />
                  <span style={{ fontWeight: 550 }}>{att}</span>
                </div>
              ))
            ) : speakers.length > 0 ? (
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
            ) : entities.length > 0 ? (
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
            ) : (
              <div style={{ fontSize: 12.5, color: "var(--t3)", fontStyle: "italic" }}>
                Nenhum participante identificado formalmente.
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
