"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  ApiError,
  confirmMfaSetup,
  getMfaStatus,
  signOut,
  startMfaSetup,
} from "../../lib/api";

type SetupDetails = {
  secret: string;
  otpauthUri: string;
};

export default function MfaSetupPage() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<any>(null);
  const [setup, setSetup] = useState<SetupDetails | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getMfaStatus()
      .then((value) => {
        setStatus(value);
        if (value?.mfa_enabled && value?.sessionMfaVerified) {
          window.location.replace("/");
        }
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          window.location.replace("/");
          return;
        }
        setError(err instanceof Error ? err.message : "Unable to load MFA status.");
      })
      .finally(() => setLoading(false));
  }, []);

  async function beginSetup() {
    setBusy(true);
    setError("");
    try {
      const result = await startMfaSetup();
      setSetup(result);
      setCode("");
      setRecoveryCodes([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start MFA setup.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await confirmMfaSetup(code.trim());
      setRecoveryCodes(result.recoveryCodes || []);
      setStatus((current: any) => ({ ...current, mfa_enabled: true, sessionMfaVerified: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to confirm MFA setup.");
    } finally {
      setBusy(false);
    }
  }

  async function logoutAndRestart() {
    setBusy(true);
    try {
      await signOut();
    } finally {
      window.location.replace("/");
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setError("Copy failed. Select and copy the value manually.");
    }
  }

  if (loading) return <div className="center">Loading MFA setup…</div>;

  return (
    <main className="login-page">
      <div className="login-box" style={{ maxWidth: 620 }}>
        <div className="admin-mark">A</div>
        <h1>Secure Super Admin</h1>
        <p>Multi-factor authentication is required before platform administration can be used.</p>

        {error && <div className="alert bad">{error}</div>}

        {status?.mfa_enabled && !recoveryCodes.length && (
          <>
            <div className="alert info">
              MFA is already configured for this account, but this session has not completed MFA verification.
              Sign out and sign in again to enter your authenticator or recovery code.
            </div>
            <button className="primary" disabled={busy} onClick={logoutAndRestart}>
              {busy ? "Signing out…" : "Sign out and verify MFA"}
            </button>
          </>
        )}

        {!status?.mfa_enabled && !setup && !recoveryCodes.length && (
          <>
            <div className="alert info">
              Use an authenticator app such as Google Authenticator, Microsoft Authenticator, 1Password,
              or another TOTP-compatible app.
            </div>
            <button className="primary" disabled={busy} onClick={beginSetup}>
              {busy ? "Starting…" : "Start MFA setup"}
            </button>
          </>
        )}

        {setup && !recoveryCodes.length && (
          <form onSubmit={confirmSetup}>
            <div className="alert info">
              Add a new account in your authenticator app. You can use the setup key below or open the authenticator URI.
            </div>

            <label>
              Setup key
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input readOnly value={setup.secret} style={{ fontFamily: "monospace" }} />
                <button type="button" onClick={() => copy(setup.secret)}>Copy</button>
              </div>
            </label>

            <label>
              Authenticator URI
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input readOnly value={setup.otpauthUri} style={{ fontFamily: "monospace" }} />
                <button type="button" onClick={() => copy(setup.otpauthUri)}>Copy</button>
              </div>
            </label>

            <p>
              <a href={setup.otpauthUri}>Open in authenticator app</a>
            </p>

            <label>
              6-digit authenticator code
              <input
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
              />
            </label>

            <button className="primary" disabled={busy || code.length !== 6}>
              {busy ? "Verifying…" : "Enable MFA"}
            </button>
          </form>
        )}

        {recoveryCodes.length > 0 && (
          <>
            <div className="alert warn">
              MFA is enabled. Save these recovery codes now. Each code can be used only once and they will not be shown again.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, margin: "16px 0" }}>
              {recoveryCodes.map((recoveryCode) => (
                <code key={recoveryCode} style={{ padding: 10, border: "1px solid currentColor", borderRadius: 6 }}>
                  {recoveryCode}
                </code>
              ))}
            </div>
            <button
              type="button"
              onClick={() => copy(recoveryCodes.join("\n"))}
              style={{ marginRight: 8 }}
            >
              Copy recovery codes
            </button>
            <button className="primary" type="button" onClick={() => window.location.replace("/")}>
              I saved them — continue to Super Admin
            </button>
          </>
        )}
      </div>
    </main>
  );
}
