"use client";

import { useEffect, useState } from "react";

export interface ModelInfo {
  stream: string;
  chat: string;
}

export function useModelInfo(): ModelInfo {
  const [models, setModels] = useState<ModelInfo>({
    stream: "qwen/qwen3.8-27b",
    chat: "claude-3-5-haiku-20241022",
  });

  useEffect(() => {
    let alive = true;
    fetch("/api/models")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d) {
          setModels({
            stream: d.stream || "qwen/qwen3.8-27b",
            chat: d.chat || "claude-3-5-haiku-20241022",
          });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return models;
}

export function ModelChips() {
  const models = useModelInfo();

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
      <div
        title={`Stream LLM: ${models.stream}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 8px",
          background: "var(--panel)",
          border: "1px solid var(--line2)",
          borderRadius: 6,
          fontSize: 11.5,
          fontFamily: "var(--mono)",
          color: "var(--t1)",
          lineHeight: 1.2,
        }}
      >
        <span style={{ color: "var(--t3)", fontWeight: 500 }}>stream</span>
        <span style={{ fontWeight: 600, color: "var(--t1)" }}>{models.stream}</span>
      </div>

      <div
        title={`Chat LLM: ${models.chat}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 8px",
          background: "var(--panel)",
          border: "1px solid var(--line2)",
          borderRadius: 6,
          fontSize: 11.5,
          fontFamily: "var(--mono)",
          color: "var(--t1)",
          lineHeight: 1.2,
        }}
      >
        <span style={{ color: "var(--t3)", fontWeight: 500 }}>chat</span>
        <span style={{ fontWeight: 600, color: "var(--t1)" }}>{models.chat}</span>
      </div>
    </div>
  );
}
