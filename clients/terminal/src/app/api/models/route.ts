import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const stream =
    process.env.VEXA_MEETING_MODEL ||
    process.env.VEXA_LLM_MODEL ||
    "qwen/qwen3.8-27b";

  const chat =
    process.env.VEXA_AGENT_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    "claude-3-5-haiku-20241022";

  return NextResponse.json({
    stream,
    chat,
    streaming_model: stream,
    meeting_model: stream,
    chat_model: chat,
    agent_model: chat,
  });
}
