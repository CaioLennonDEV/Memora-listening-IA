import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const LLM_BRIDGE_URL = process.env.LLM_BRIDGE_URL || "http://llm-bridge:4000";
const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY || "";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { meeting_id, native_id, title, segments, transcript } = body;

    const displayTitle = title || `Reunião ${native_id || meeting_id || ""}`;
    
    // Compile transcript text
    let transcriptText = "";
    if (typeof transcript === "string" && transcript.trim()) {
      transcriptText = transcript.trim();
    } else if (Array.isArray(segments) && segments.length > 0) {
      transcriptText = segments
        .slice(-150)
        .map((s: { speaker?: string; text?: string }) => `${s.speaker || "Participante"}: ${s.text || ""}`)
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

    // Call LLM Bridge
    let responseText = "";
    const bridgeUrls = [LLM_BRIDGE_URL, "http://127.0.0.1:4000", "http://localhost:4000"];

    for (const url of bridgeUrls) {
      try {
        const resp = await fetch(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: "qwen/qwen3.8-27b",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.3,
            max_tokens: 3000,
          }),
          signal: AbortSignal.timeout(180000),
        });

        if (resp.ok) {
          const data = await resp.json();
          responseText = data.choices?.[0]?.message?.content || "";
          if (responseText) break;
        }
      } catch {
        // Try next fallback URL
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
