"use client";
/** Settings — the footer-gear CENTER tab (design-spec meeting-lifecycle-v2, W5): account-level
 *  configuration in one place — Calendar integration, API tokens, GitHub token, Account. The old
 *  "API Tokens" activity-bar item retired into here (its panels are imported, not duplicated);
 *  the Meetings sidebar keeps its own first-connect calendar card at the point of need — this is
 *  the durable home (multi-calendar management lives in `calendarConnections.tsx`). Sections are a left nav (no sub-routing; one tab, local state). */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { registerTab } from "../contributions";
import { Icon } from "../ui-kit";
import { GitHubTokenCard, TokensPanel } from "./tokens";
import { presentError } from "./apiClient";
import { CalendarConnectionsPanel } from "./calendarConnections";
import { getModelPrefs, setModelPrefs, getTranscriptionPrefs, setTranscriptionPrefs, getGlobalSetting, setGlobalSetting, getWhitelistEmails, setWhitelistEmails, getUserRoles, setUserRole, type UserRoleInfo, testModels, testTranscription, type ConfigTestResult } from "./settingsApi";

type SectionId = "calendar" | "whitelist" | "models" | "tokens" | "github" | "account";
const SECTIONS: Array<{ id: SectionId; label: string; icon: string }> = [
  { id: "calendar", label: "Calendar", icon: "cal" },
  { id: "whitelist", label: "Whitelist", icon: "mail" },
  { id: "models", label: "Models", icon: "spark" },
  { id: "tokens", label: "API tokens", icon: "key" },
  { id: "github", label: "GitHub", icon: "github" },
  { id: "account", label: "Account", icon: "user" },
];

const field: CSSProperties = { width: "100%", boxSizing: "border-box", fontSize: 12, padding: "6px 9px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--t1)" };
const btn: CSSProperties = { fontSize: 12, padding: "5px 12px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--t1)", cursor: "pointer" };

/** One models/transcription config form — the SAME fields serve the per-user prefs and (for
 *  admins) the global platform defaults; only load/save differ. Secrets arrive MASKED
 *  (********abcd): an untouched masked value is never sent back, typing replaces it, emptying a
 *  previously-set field clears it (empty string = clear, the API's contract). */
function ConfigForm({ fields, load, save, note }: {
  fields: Array<{ key: string; label: string; placeholder?: string; secret?: boolean; options?: Array<{ value: string; label: string }>; showIf?: (v: Record<string, string>) => boolean }>;
  load: () => Promise<Record<string, string>>;
  save: (update: Record<string, string>) => Promise<Record<string, string>>;
  note?: string;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [initial, setInitial] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let on = true;
    load().then((v) => { if (on) { setValues(v); setInitial(v); } })
      .catch((e: unknown) => on && setErr(presentError(e).headline));
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = fields.some((f) => (values[f.key] ?? "") !== (initial[f.key] ?? ""));
  const doSave = async () => {
    setBusy(true); setErr(null); setSaved(false);
    // Send only what changed; an untouched masked secret stays server-side.
    const update: Record<string, string> = {};
    for (const f of fields) {
      if ((values[f.key] ?? "") !== (initial[f.key] ?? "")) update[f.key] = values[f.key] ?? "";
    }
    try { const v = await save(update); setValues(v); setInitial(v); setSaved(true); }
    catch (e: unknown) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 460 }}>
      {note && <div style={{ fontSize: 11, color: "var(--t3)", lineHeight: 1.5 }}>{note}</div>}
      {err && <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)" }}>⚠ {err}</div>}
      {fields.map((f) => (f.showIf && !f.showIf(values)) ? null : (
        <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
          <span style={{ width: 110, flex: "none", color: "var(--t3)" }}>{f.label}</span>
          {f.options ? (
            <select value={values[f.key] ?? ""}
              onChange={(e) => { setSaved(false); setValues((v) => ({ ...v, [f.key]: e.target.value })); }}
              style={{ ...field, width: "auto", flex: 1 }}>
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input value={values[f.key] ?? ""} placeholder={f.placeholder}
              type={f.secret && (values[f.key] ?? "") !== (initial[f.key] ?? "") ? "password" : "text"}
              onChange={(e) => { setSaved(false); setValues((v) => ({ ...v, [f.key]: e.target.value })); }}
              style={field} />
          )}
        </label>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button disabled={busy || !dirty} onClick={() => void doSave()}
          style={{ ...btn, background: dirty ? "var(--accent)" : "var(--panel2)", color: dirty ? "var(--on-accent)" : "var(--t3)", border: dirty ? "none" : btn.border, opacity: busy ? 0.5 : 1 }}>
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && <span style={{ fontSize: 11.5, color: "var(--green)" }}>Saved — next agent turn uses it</span>}
      </div>
    </div>
  );
}

/** On-demand credential test row (fail-loud surface): runs the EFFECTIVE config — the same
 *  user > global > env resolution a chat turn / bot spawn applies — against the real backend
 *  and prints the verdict inline, remedy included. What Save can't tell you, Test does. */
function TestRow({ label, run }: { label: string; run: () => Promise<ConfigTestResult> }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ConfigTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const doTest = async () => {
    setBusy(true); setErr(null); setRes(null);
    try { setRes(await run()); }
    catch (e: unknown) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };
  const provenance = res ? [res.mode, res.source && `via ${res.source}`].filter(Boolean).join(" · ") : "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 460, marginTop: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button disabled={busy} onClick={() => void doTest()}
          style={{ ...btn, opacity: busy ? 0.5 : 1 }}>
          {busy ? "Testing…" : label}
        </button>
        {res && (
          <span style={{ fontSize: 11.5, color: res.ok ? "var(--green)" : "var(--danger)" }}>
            {res.ok ? "✓" : "✗"} {provenance && <span style={{ color: "var(--t3)" }}>[{provenance}] </span>}
            {res.summary}
          </span>
        )}
        {err && <span role="alert" style={{ fontSize: 11.5, color: "var(--danger)" }}>⚠ test failed: {err}</span>}
      </div>
    </div>
  );
}

/** Models — which LLM the agent runs on and which STT backend the bot transcribes with; your own
 *  settings first, the deployment-wide defaults below for admins. Empty fields = the level below
 *  decides (global settings, then the deployment env). */
function ModelsSection() {
  const [globalAdmin, setGlobalAdmin] = useState(false);
  useEffect(() => {
    let on = true;
    // Admin probe: the global card renders only when /api/admin/settings answers (404 = not admin).
    getGlobalSetting("models").then((v) => on && setGlobalAdmin(v !== null)).catch(() => undefined);
    return () => { on = false; };
  }, []);

  const modelFields = [
    { key: "mode", label: "Provider", options: [
      { value: "", label: "Deployment default" },
      { value: "subscription", label: "Claude subscription (deployment credentials)" },
      { value: "custom", label: "Custom endpoint (open-source / gateway)" },
    ] },
    { key: "base_url", label: "Base URL", placeholder: "https://… (Anthropic/OpenAI-compatible gateway)", showIf: (v: Record<string, string>) => v.mode === "custom" },
    { key: "api_key", label: "API key", placeholder: "unchanged unless typed", secret: true, showIf: (v: Record<string, string>) => v.mode === "custom" },
    { key: "model", label: "Chat model", placeholder: "deployment default (e.g. sonnet)" },
    { key: "meeting_model", label: "Meeting model", placeholder: "defaults to chat model" },
    { key: "effort", label: "Reasoning effort", placeholder: "CLI default (e.g. medium)", options: [
      { value: "", label: "CLI default" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
      { value: "xhigh", label: "xhigh" },
    ] },
  ];
  const transcriptionFields = [
    { key: "url", label: "Service URL", placeholder: "deployment default" },
    { key: "token", label: "Token", placeholder: "unchanged unless typed", secret: true },
  ];
  const asStrings = (v: Record<string, unknown>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === "string" && val) out[k] = val;
    return out;
  };
  const head: CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--t1)", margin: "14px 0 6px" };

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--t3)", lineHeight: 1.5, marginBottom: 12, maxWidth: 460 }}>
        Which model the agent runs on, and which transcription service meeting bots use. Provider
        &ldquo;subscription&rdquo; rides the deployment&rsquo;s Claude credentials; &ldquo;custom&rdquo; points at your own
        Anthropic/OpenAI-compatible endpoint (a LiteLLM/OpenRouter gateway serves open-source
        models). Empty fields inherit the deployment defaults.
      </div>
      <div style={head}>Your models</div>
      <ConfigForm fields={modelFields} load={async () => asStrings(await getModelPrefs())}
        save={async (u) => asStrings(await setModelPrefs(u))} />
      <TestRow label="Test model credentials" run={testModels} />
      <div style={head}>Your transcription backend</div>
      <ConfigForm fields={transcriptionFields} load={async () => asStrings(await getTranscriptionPrefs())}
        save={async (u) => asStrings(await setTranscriptionPrefs(u))} />
      <TestRow label="Test transcription backend" run={testTranscription} />
      {globalAdmin && <>
        <div style={{ ...head, marginTop: 22, color: "var(--accent)" }}>Global defaults (admin — every user without own settings)</div>
        <ConfigForm fields={modelFields} load={async () => (await getGlobalSetting("models")) ?? {}}
          save={(u) => setGlobalSetting("models", u)} />
        <div style={head}>Global transcription backend</div>
        <ConfigForm fields={transcriptionFields} load={async () => (await getGlobalSetting("transcription")) ?? {}}
          save={(u) => setGlobalSetting("transcription", u)} />
      </>}
    </div>
  );
}

function AccountSection() {
  const [user, setUser] = useState<{ email?: string | null; name?: string | null } | null>(null);
  useEffect(() => {
    let on = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => on && setUser((d?.user as { email?: string; name?: string } | undefined) ?? null))
      .catch(() => undefined);
    return () => { on = false; };
  }, []);
  return (
    <div style={{ fontSize: 12.5, color: "var(--t2)", lineHeight: 1.9 }}>
      <div><span style={{ color: "var(--t3)" }}>Signed in as</span> <span style={{ color: "var(--t1)" }}>{user?.name || user?.email || "…"}</span></div>
      {user?.email && <div><span style={{ color: "var(--t3)" }}>Email</span> <span style={{ fontFamily: "var(--mono)" }}>{user.email}</span></div>}
      <div style={{ color: "var(--t3)", marginTop: 6 }}>Sign-out lives next to your name in the footer.</div>
    </div>
  );
}

function WhitelistSection() {
  const [emails, setEmails] = useState<string[]>([]);
  const [roles, setRoles] = useState<UserRoleInfo[]>([]);
  const [currentUserEmail, setCurrentUserEmail] = useState<string>("");
  const [inputVal, setInputVal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState(false);
  const [roleFeedback, setRoleFeedback] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    Promise.all([
      getWhitelistEmails(),
      getUserRoles(),
      fetch("/api/auth/me", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    ])
      .then(([list, userRoles, me]) => {
        if (on) {
          setEmails(list);
          setRoles(userRoles);
          if (me?.email) setCurrentUserEmail(String(me.email).toLowerCase());
        }
      })
      .catch((e: unknown) => { if (on) setErr(presentError(e).headline); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, []);

  const addEmail = async () => {
    const target = inputVal.trim().toLowerCase();
    if (!target) return;
    if (!target.includes(".")) {
      setErr("Por favor insira um e-mail válido (ex: nome@empresa.com) ou domínio (ex: @empresa.com).");
      return;
    }
    if (emails.includes(target)) {
      setErr("Este e-mail ou domínio já está na whitelist.");
      return;
    }
    const next = [...emails, target];
    setEmails(next);
    setInputVal("");
    setErr(null);
    await persist(next);
  };

  const removeEmail = async (emailToRemove: string) => {
    const normalized = emailToRemove.toLowerCase();
    const userRole = roles.find((r) => r.email.toLowerCase() === normalized);
    if (userRole?.is_owner) {
      setErr("O Dono do Workspace não pode ser removido da whitelist.");
      return;
    }
    const next = emails.filter((e) => e !== emailToRemove);
    setEmails(next);
    setErr(null);
    await persist(next);
  };

  const toggleAdminRole = async (email: string, makeAdmin: boolean) => {
    const normalized = email.toLowerCase();
    const userRole = roles.find((r) => r.email.toLowerCase() === normalized);
    if (!makeAdmin) {
      if (userRole?.is_owner) {
        setErr("O Dono do Workspace é o proprietário principal e não pode ter seu acesso de Administrador revogado.");
        return;
      }
      if (normalized === currentUserEmail) {
        setErr("Você não pode remover seu próprio acesso de Administrador.");
        return;
      }
      if (!window.confirm(`Tem certeza que deseja revogar o acesso de Administrador de ${email}?`)) {
        return;
      }
    }
    setRoleFeedback(null);
    setErr(null);
    try {
      const res = await setUserRole(email, makeAdmin);
      if (res) {
        setRoles((prev) => {
          const next = prev.filter((r) => r.email.toLowerCase() !== email.toLowerCase());
          next.push(res);
          return next;
        });
        setRoleFeedback(
          makeAdmin
            ? `✓ ${email} promovido a Administrador com sucesso!`
            : `✓ Permissão de administrador revogada para ${email}.`
        );
        setTimeout(() => setRoleFeedback(null), 3500);
      }
    } catch (e: unknown) {
      setErr(presentError(e).headline);
    }
  };

  const persist = async (list: string[]) => {
    setSaving(true);
    setSavedMsg(false);
    try {
      const saved = await setWhitelistEmails(list);
      setEmails(saved);
      setSavedMsg(true);
      setTimeout(() => setSavedMsg(false), 3000);
    } catch (e: unknown) {
      setErr(presentError(e).headline);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 600, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 11.5, color: "var(--t3)", lineHeight: 1.6 }}>
        Cadastre os e-mails ou domínios autorizados a receber atas e transcrições de reuniões e a acessar o terminal.
        <div style={{ marginTop: 6, color: "var(--t2)", padding: "6px 10px", borderRadius: 6, background: "var(--panel2)", border: "1px solid var(--line)" }}>
          💡 <b>Dica:</b> Você pode autorizar um e-mail individual ou o domínio inteiro com <code>@</code> (ex: <code>@unimed.com.br</code>). Você também pode <b>promover qualquer membro para Administrador</b> diretamente na lista abaixo.
        </div>
      </div>

      {err && <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)" }}>⚠ {err}</div>}
      {roleFeedback && (
        <div style={{ fontSize: 11.5, color: "var(--green)", padding: "6px 10px", borderRadius: 6, background: "var(--panel2)", border: "1px solid var(--line)" }}>
          {roleFeedback}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={inputVal}
          onChange={(e) => { setInputVal(e.target.value); setErr(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addEmail(); } }}
          placeholder="exemplo: isabella@unimed.com.br ou @unimed.com.br"
          style={{ ...field, flex: 1 }}
        />
        <button
          type="button"
          onClick={() => void addEmail()}
          disabled={saving || !inputVal.trim()}
          style={{
            ...btn,
            background: inputVal.trim() ? "var(--accent)" : "var(--panel2)",
            color: inputVal.trim() ? "var(--on-accent)" : "var(--t3)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Icon name="plus" size={13} /> Adicionar
        </button>
      </div>

      <div style={{ background: "var(--panel2)", borderRadius: 8, border: "1px solid var(--line)", padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--t1)" }}>
            E-mails e domínios autorizados ({emails.length})
          </span>
          {savedMsg && (
            <span style={{ fontSize: 11, color: "var(--green)", display: "flex", alignItems: "center", gap: 4 }}>
              <Icon name="check" size={12} /> Salvo no banco de dados
            </span>
          )}
          {saving && <span style={{ fontSize: 11, color: "var(--t3)" }}>Salvando...</span>}
        </div>

        {loading ? (
          <div style={{ fontSize: 11.5, color: "var(--t3)", padding: "10px 0" }}>Carregando whitelist...</div>
        ) : emails.length === 0 ? (
          <div style={{ fontSize: 11.5, color: "var(--t3)", padding: "12px 0", textAlign: "center" }}>
            Nenhum e-mail cadastrado na whitelist.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {emails.map((email) => {
              const isDomain = email.startsWith("@");
              const isMe = email.toLowerCase() === currentUserEmail;
              const userRole = roles.find((r) => r.email.toLowerCase() === email.toLowerCase());
              const isOwner = userRole?.is_owner === true;
              const isAdmin = userRole?.is_admin === true || isOwner;

              return (
                <div
                  key={email}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "7px 10px",
                    borderRadius: 6,
                    background: "var(--panel)",
                    border: "1px solid var(--line)",
                    fontSize: 12,
                    color: "var(--t1)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                    <Icon name={isDomain ? "globe" : "mail"} size={13} style={{ color: isDomain ? "var(--t3)" : "var(--accent)", flexShrink: 0 }} />
                    <span style={{ fontFamily: "var(--mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</span>
                    {isDomain ? (
                      <span style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 4, background: "var(--panel2)", color: "var(--t3)", border: "1px solid var(--line)" }}>
                        Domínio
                      </span>
                    ) : isOwner ? (
                      <span style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 4, background: "var(--warnbg)", color: "var(--warn)", border: "1px solid var(--warn)", fontWeight: 600 }}>
                        {isMe ? "👑 Você (Dono)" : "👑 Dono do Workspace"}
                      </span>
                    ) : isAdmin ? (
                      <span style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 4, background: "var(--warnbg)", color: "var(--warn)", border: "1px solid var(--warn)", fontWeight: 600 }}>
                        {isMe ? "👑 Você (Admin)" : "👑 Admin"}
                      </span>
                    ) : (
                      <span style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 4, background: "var(--panel2)", color: "var(--t3)", border: "1px solid var(--line)" }}>
                        Membro
                      </span>
                    )}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    {!isDomain && (
                      isOwner ? (
                        <span style={{ fontSize: 11, color: "var(--t3)", fontStyle: "italic", padding: "2px 6px" }}>
                          {isMe ? "Sua Conta" : "Dono"}
                        </span>
                      ) : isAdmin ? (
                        isMe ? (
                          <span style={{ fontSize: 11, color: "var(--t3)", fontStyle: "italic", padding: "2px 6px" }}>
                            Sua Conta
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void toggleAdminRole(email, false)}
                            title="Remover privilégios de Administrador deste usuário"
                            style={{
                              ...btn,
                              fontSize: 10.5,
                              padding: "2px 7px",
                              background: "transparent",
                              color: "var(--t3)",
                            }}
                          >
                            Rebaixar
                          </button>
                        )
                      ) : (
                        <button
                          type="button"
                          onClick={() => void toggleAdminRole(email, true)}
                          title="Promover este usuário a Administrador"
                          style={{
                            ...btn,
                            fontSize: 10.5,
                            padding: "2px 7px",
                            background: "var(--warnbg)",
                            color: "var(--warn)",
                            border: "1px solid var(--warn)",
                            fontWeight: 600,
                          }}
                        >
                          ⭐ Tornar Admin
                        </button>
                      )
                    )}

                    {!isOwner && (
                      <button
                        type="button"
                        title="Remover e-mail da whitelist"
                        onClick={() => void removeEmail(email)}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "var(--t3)",
                          cursor: "pointer",
                          padding: "2px 4px",
                          borderRadius: 4,
                          display: "flex",
                          alignItems: "center",
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--danger)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--t3)"; }}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsView() {
  const [section, setSection] = useState<SectionId>("calendar");
  const bodies: Record<SectionId, ReactNode> = {
    calendar: <CalendarConnectionsPanel />,
    whitelist: <WhitelistSection />,
    models: <ModelsSection />,
    tokens: <TokensPanel />,
    github: <GitHubTokenCard />,
    account: <AccountSection />,
  };
  return (
    <div style={{ height: "100%", display: "flex", minHeight: 0 }}>
      <div style={{ width: 160, flex: "none", borderRight: "1px solid var(--line)", padding: "14px 8px", background: "var(--sidebar)" }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--t1)", padding: "0 8px 10px" }}>Settings</div>
        {SECTIONS.map((s) => (
          <button key={s.id} onClick={() => setSection(s.id)}
            style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left", fontSize: 12.5,
              padding: "6px 9px", borderRadius: 7, border: "none", cursor: "pointer",
              color: section === s.id ? "var(--t1)" : "var(--t2)", background: section === s.id ? "var(--panel2)" : "transparent" }}>
            <Icon name={s.icon} size={13} />{s.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px", minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--t1)", marginBottom: 12 }}>
          {SECTIONS.find((s) => s.id === section)?.label}
        </div>
        {bodies[section]}
      </div>
    </div>
  );
}

registerTab("settings", SettingsView);
