"use client";
import { useEffect, useState } from "react";
type Token = {
  id: string;
  name: string;
  siteIds: string[];
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};
const permissions = [
  { id: "sites:read", label: "List selected sites" },
  { id: "audits:read", label: "Read audits, findings and comparisons" },
  { id: "search:read", label: "Read saved search opportunities" },
];
export function ApiAccess({
  workspaceId,
  sites,
  collectionEnabled = true,
}: {
  collectionEnabled?: boolean;
  workspaceId: string;
  sites: Array<{ id: string; origin: string }>;
}) {
  const [tokens, setTokens] = useState<Token[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [scopes, setScopes] = useState<string[]>(["sites:read"]);
  const [name, setName] = useState(""),
    [days, setDays] = useState(30),
    [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("Loading your credentials…"),
    [fresh, setFresh] = useState(false);
  const [openedAt] = useState(() => Date.now());
  const query = `workspaceId=${encodeURIComponent(workspaceId)}`;
  async function request(command?: Record<string, unknown>) {
    const response = await fetch(
      `/api/tokens${command ? "" : `?${query}`}`,
      command
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId, ...command }),
          }
        : { cache: "no-store" },
    );
    const value = await response.json();
    if (!response.ok) {
      setFresh(value.code === "FRESH_AUTH_REQUIRED");
      throw new Error(value.error ?? "Credential access is unavailable.");
    }
    return value;
  }
  useEffect(() => {
    let active = true;
    fetch(`/api/tokens?${query}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Credentials could not load. Refresh to retry.");
        return response.json();
      })
      .then((value) => {
        if (active) {
          setTokens(value.tokens);
          setMessage(
            "Create a credential with only the sites and read permissions your client needs.",
          );
        }
      })
      .catch((error) => {
        if (active) setMessage(error.message);
      });
    return () => {
      active = false;
    };
  }, [query]);
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setFresh(false);
    try {
      await work();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to update credentials.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {!collectionEnabled && (
        <p className="notice" role="status">
          This capability is paused. Saved evidence remains readable; safe
          recovery controls remain available.
        </p>
      )}
      <section className="pilot-card" aria-labelledby="api-read-access">
        <h2 id="api-read-access">Read-only API and MCP access</h2>
        <p>
          Credentials can read saved evidence for selected sites. They cannot
          start audits, import data or spend your allowance. Access ends when
          you revoke the credential, it expires, or your site access changes.
        </p>
        <p>
          MCP endpoint: <code>/api/mcp</code>. Configure your MCP client with
          this deployment’s HTTPS URL and the credential as a Bearer token.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void perform(async () => {
              const value = await request({
                action: "create",
                name,
                siteIds: selected,
                scopes,
                expiresInDays: days,
                requestKey: crypto.randomUUID(),
              });
              setSecret(value.secret);
              setTokens((existing) => [value.token, ...existing]);
              setName("");
              setMessage(
                "Credential created. Copy its secret now; it cannot be retrieved again.",
              );
            });
          }}
        >
          <fieldset disabled={busy || !!secret || !collectionEnabled}>
            <legend>New credential</legend>
            <label htmlFor="token-name">Credential name</label>
            <input
              id="token-name"
              className="audit-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
            />
            <label htmlFor="token-days">Expires in days (1–90)</label>
            <input
              id="token-days"
              className="audit-input"
              type="number"
              min={1}
              max={90}
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              required
            />
            <fieldset>
              <legend>Sites this credential may read</legend>
              {sites.length ? (
                sites.map((site) => (
                  <label className="audit-source" key={site.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(site.id)}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? [...selected, site.id]
                            : selected.filter((id) => id !== site.id),
                        )
                      }
                    />
                    {site.origin}
                  </label>
                ))
              ) : (
                <p>
                  No authorized sites. Ask your workspace administrator for a
                  site grant.
                </p>
              )}
            </fieldset>
            <fieldset>
              <legend>Allowed reads</legend>
              {permissions.map((permission) => (
                <label className="audit-source" key={permission.id}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(permission.id)}
                    onChange={(event) =>
                      setScopes(
                        event.target.checked
                          ? [...scopes, permission.id]
                          : scopes.filter((id) => id !== permission.id),
                      )
                    }
                  />
                  {permission.label}
                </label>
              ))}
            </fieldset>
            <button
              className="button button-primary"
              disabled={!name.trim() || !selected.length || !scopes.length}
            >
              Create read-only credential
            </button>
          </fieldset>
        </form>
        {secret && (
          <div>
            <label htmlFor="new-token-secret">One-time credential secret</label>
            <textarea
              id="new-token-secret"
              className="audit-input"
              value={secret}
              readOnly
              rows={3}
              spellCheck={false}
            />
            <p>
              Store this secret in your client’s credential manager. It is
              visible only in this browser state until dismissed or the page is
              closed.
            </p>
            <div className="pilot-tabs">
              <button
                className="button button-secondary"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(secret)
                    .then(() => setMessage("Credential copied to clipboard."))
                    .catch(() =>
                      setMessage(
                        "Clipboard unavailable. Select and copy the credential manually.",
                      ),
                    )
                }
              >
                Copy credential
              </button>
              <button
                className="button button-secondary"
                onClick={() => {
                  setSecret("");
                  setMessage(
                    "Secret dismissed. Revoke this credential and create another if you did not save it.",
                  );
                }}
              >
                Dismiss secret
              </button>
            </div>
          </div>
        )}
        <p role="status" aria-live="polite">
          {message}
        </p>
        {fresh && (
          <p>
            <a href="/sign-in">Sign in again</a> before creating or revoking a
            credential. The form above preserves your current selections.
          </p>
        )}
      </section>
      <section className="pilot-card" aria-labelledby="saved-tokens">
        <h2 id="saved-tokens">Your credentials</h2>
        {!tokens.length && <p>No credentials created in this workspace.</p>}
        <ul className="audit-history">
          {tokens.map((token) => (
            <li key={token.id}>
              <h3>{token.name}</h3>
              <p>
                {token.revokedAt
                  ? "Revoked"
                  : new Date(token.expiresAt).getTime() <= openedAt
                    ? "Expired"
                    : "Active"}{" "}
                · expires {new Date(token.expiresAt).toLocaleString()}
              </p>
              <p>
                {token.siteIds
                  .map(
                    (id) =>
                      sites.find((site) => site.id === id)?.origin ??
                      "Site access no longer available",
                  )
                  .join(", ")}
              </p>
              <p>
                {token.scopes
                  .map(
                    (scope) =>
                      permissions.find((p) => p.id === scope)?.label ?? scope,
                  )
                  .join(" · ")}
              </p>
              {!token.revokedAt && (
                <button
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await request({ action: "revoke", tokenId: token.id });
                      setTokens((existing) =>
                        existing.map((item) =>
                          item.id === token.id
                            ? { ...item, revokedAt: new Date().toISOString() }
                            : item,
                        ),
                      );
                      setSecret("");
                      setMessage(
                        `${token.name} revoked. It can no longer retrieve evidence.`,
                      );
                    })
                  }
                >
                  Revoke {token.name}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
