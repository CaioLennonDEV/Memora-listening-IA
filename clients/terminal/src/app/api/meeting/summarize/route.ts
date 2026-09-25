import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

if (typeof process !== "undefined" && process.env) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const LLM_BRIDGE_URL = process.env.LLM_BRIDGE_URL || "http://llm-bridge:4000";
const GROQ_API_KEY =
  process.env.VEXA_LLM_API_KEY ||
  process.env.GROQ_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  "";
const GROQ_BASE_URL = process.env.VEXA_LLM_BASE_URL || "https://api.groq.com/openai/v1";
const MODEL_NAME = process.env.VEXA_LLM_MODEL || "qwen/qwen3.8-27b";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { meeting_id, native_id, title, segments, transcript, notes } = body;

    const displayTitle = title || `Reunião ${native_id || meeting_id || ""}`;

    // Compile transcript text from any available source
    let transcriptText = "";
    if (typeof transcript === "string" && transcript.trim()) {
      transcriptText = transcript.trim();
    } else if (Array.isArray(segments) && segments.length > 0) {
      transcriptText = segments
        .slice(-150)
        .map((s: { speaker?: string; text?: string }) => `${s.speaker || "Participante"}: ${s.text || ""}`)
        .join("\n");
    } else if (Array.isArray(notes) && notes.length > 0) {
      transcriptText = notes
        .map((n: { speaker?: string; text?: string }) => `${n.speaker || "Participante"}: ${n.text || ""}`)
        .join("\n");
    }

    if (!transcriptText) {
      return NextResponse.json(
        { error: "Transcrição vazia ou não fornecida", success: false },
        { status: 400 }
      );
    }

    const systemPrompt = [
      "Você é um redator executivo sênior e especialista em síntese de reuniões corporativas.",
      "Sua missão é ler a transcrição e gerar uma ATA DE REUNIÃO EXECUTIVA OFICIAL completa, objetiva e estruturada em Português do Brasil.",
      "",
      "Estruture OBRIGATORIAMENTE a ata nas seguintes seções em Markdown:",
      "# Ata de Reunião: " + displayTitle,
      "",
      "## Participantes",
      "- [Nome do Participante 1] (Área/Função)",
      "- [Nome do Participante 2] (Área/Função)",
      "",
      "## Resumo Executivo",
      "(Apresente um resumo claro e profissional em 2 a 4 parágrafos explicando o contexto da reunião, o objetivo principal e o que foi conversado/alinhado)",
      "",
      "## Decisões",
      "- [Decisão ou acordo 1]",
      "- [Decisão ou acordo 2]",
      "",
      "## Actions",
      "- [ ] [Descrição da tarefa ou próximo passo] — responsável: [[Nome]]",
      "- [ ] [Outra tarefa] — responsável: [[Nome]]",
      "",
      "## Topics",
      "- [Pauta ou tema 1]",
      "- [Pauta ou tema 2]",
      "",
      "Regras:",
      "1. Seja fiel ao que foi discutido na transcrição.",
      "2. Corrija pontuação e gramática de falas confusas da transcrição automática.",
      "3. Destaque todas as decisões e compromissos tomados pelos participantes.",
      "4. Não invente fatos fora do contexto da conversa.",
    ].join("\n");

    const userPrompt = `Abaixo está a transcrição da reunião "${displayTitle}":\n\n${transcriptText}\n\nPor favor, elabore a ATA OFICIAL E EXECUTIVA agora:`;

    let responseText = "";

    // 1. First attempt: Direct Groq API call
    if (GROQ_API_KEY) {
      try {
        const groqResp = await fetch(`${GROQ_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: MODEL_NAME,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.3,
            max_tokens: 3000,
          }),
          signal: AbortSignal.timeout(60000),
        });

        if (groqResp.ok) {
          const data = await groqResp.json();
          responseText = data.choices?.[0]?.message?.content || "";
        }
      } catch (e) {
        console.warn("Direct Groq call failed, trying llm-bridge...", e);
      }
    }

    // 2. Second attempt: LLM Bridge /v1/messages (Anthropic payload format used by llm-bridge)
    if (!responseText) {
      const bridgeUrls = [LLM_BRIDGE_URL, "http://llm-bridge:4000", "http://127.0.0.1:4000", "http://localhost:4000"];
      for (const url of bridgeUrls) {
        try {
          const resp = await fetch(`${url}/v1/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": GROQ_API_KEY,
              "Authorization": `Bearer ${GROQ_API_KEY}`,
            },
            body: JSON.stringify({
              model: MODEL_NAME,
              system: systemPrompt,
              messages: [{ role: "user", content: userPrompt }],
              max_tokens: 3000,
              temperature: 0.3,
            }),
            signal: AbortSignal.timeout(90000),
          });

          if (resp.ok) {
            const data = await resp.json();
            if (Array.isArray(data.content)) {
              responseText = data.content.map((c: { text?: string }) => c.text || "").join("\n");
            } else if (typeof data.content === "string") {
              responseText = data.content;
            }
            if (responseText) break;
          }
        } catch {
          // Try next fallback URL
        }
      }
    }

    if (!responseText) {
      return NextResponse.json(
        { error: "Falha ao obter resposta do modelo de IA", success: false },
        { status: 502 }
      );
    }

    return NextResponse.json({
      success: true,
      content: responseText,
      meeting_id: meeting_id || native_id,
      native_id: native_id || meeting_id,
      title: displayTitle,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro interno ao processar ata";
    return NextResponse.json({ error: message, success: false }, { status: 500 });
  }
}
