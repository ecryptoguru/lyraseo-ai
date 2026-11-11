"use client";
import { useEffect, useState } from "react";
import { useClientReady } from "./use-client-ready";
import type { HandoffSummary } from "@lyraseo/db/handoffs";
type Preview = {
  title: string;
  sourceBody: string;
  hash: string;
  draftRevisionId: string;
  draftRevision: number;
  destination: { id: string; url: string; generation: number };
};
type Revision = { id: string; title: string; revision: number };
export function ExternalHandoffs({
  workspaceId,
  siteId,
  origin,
  manager,
  editable,
  enabled,
}: {
  workspaceId: string;
  siteId: string;
  origin: string;
  manager: boolean;
  editable: boolean;
  enabled: boolean;
}) {
  const ready = useClientReady(),
    [data, setData] = useState<HandoffSummary | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [secret, setSecret] = useState<{ secret: string; keyId: string } | null>(
      null,
    ),
    [preview, setPreview] = useState<Preview | null>(null),
    [drafts, setDrafts] = useState<Revision[]>([]),
    [selected, setSelected] = useState(""),
    [installation, setInstallation] = useState(origin + "/"),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [wpConfirmed, setWpConfirmed] = useState(false),
    [endpoint, setEndpoint] = useState(""),
    [receiverConfirmed, setReceiverConfirmed] = useState(false),
    [auditEvents, setAuditEvents] = useState(false),
    [reportEvents, setReportEvents] = useState(false);
  const scope = { workspaceId, siteId },
    query = new URLSearchParams(scope).toString();
  async function read() {
    const response = await fetch(`/api/integrations/handoffs?${query}`, {
      cache: "no-store",
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error);
    setData(value);
  }
  useEffect(() => {
    let stopped = false;
    async function load() {
      try {
        const [response, content] = await Promise.all([
          fetch(`/api/integrations/handoffs?${query}`, { cache: "no-store" }),
          editable
            ? fetch(`/api/content?${query}`, { cache: "no-store" })
            : Promise.resolve(null),
        ]);
        const value = await response.json();
        if (!response.ok) throw Error(value.error);
        if (stopped) return;
        setData(value);
        const wordpress = value.destinations.find(
            (d: { kind: string }) => d.kind === "WORDPRESS",
          ),
          receiver = value.destinations.find(
            (d: { kind: string }) => d.kind === "WEBHOOK",
          );
        if (wordpress) setInstallation(wordpress.url);
        if (receiver) {
          setEndpoint(receiver.url);
          setAuditEvents(receiver.event_types.includes("audit.completed"));
          setReportEvents(receiver.event_types.includes("report.created"));
        }
        if (content?.ok) {
          const rows = await content.json();
          if (!stopped)
            setDrafts(
              rows
                .filter((d: { kind: string }) => d.kind === "draft")
                .flatMap(
                  (d: {
                    history: Array<{
                      id: string;
                      revision: number;
                      content: { title: string };
                    }>;
                  }) =>
                    d.history.map((r) => ({
                      id: r.id,
                      title: r.content.title,
                      revision: r.revision,
                    })),
                ),
            );
        }
      } catch (e) {
        if (!stopped)
          setError(e instanceof Error ? e.message : "Could not load handoffs.");
      }
    }
    void load();
    return () => {
      stopped = true;
    };
  }, [query, editable]);
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await read();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save handoff.");
    } finally {
      setBusy(false);
    }
  }
  async function post(input: Record<string, unknown>) {
    const response = await fetch("/api/integrations/handoffs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...scope, ...input }),
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error);
    return value;
  }
  const wp = data?.destinations.find((d) => d.kind === "WORDPRESS"),
    webhook = data?.destinations.find((d) => d.kind === "WEBHOOK"),
    disabled = !ready || busy || !enabled || !data;
  return (
    <section
      className="handoff-workspace"
      aria-label="Private external handoffs"
    >
      <p role="status">
        Delivery is unavailable pending hosted egress and destination
        qualification. Saving a connection or intent sends no external request.
        WordPress handoffs create drafts only; ambiguous writes require manual
        inspection.
      </p>
      {!enabled && (
        <p>
          Destination setup is paused by the operator. Existing history and
          disconnect remain available.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!data && !error && <p role="status">Loading saved handoffs…</p>}
      <p>
        Saved handoff intents keep the reviewed authored copy with your saved
        work until deletion. Delivered events and WordPress drafts remain in
        customer-controlled systems.
      </p>
      {secret && (
        <section aria-label="One-time webhook key">
          <h2>Save your receiver key</h2>
          <p>
            This secret is shown once. Store it in your receiver’s secret
            manager. Key ID: {secret.keyId}
          </p>
          <label>
            Webhook secret
            <input readOnly value={secret.secret} autoComplete="off" />
          </label>
          <button
            type="button"
            onClick={() =>
              void act(async () => {
                await navigator.clipboard.writeText(secret.secret);
                setNotice("Receiver key copied.");
              })
            }
            disabled={busy}
          >
            Copy receiver key
          </button>
          <button type="button" onClick={() => setSecret(null)}>
            Dismiss secret
          </button>
        </section>
      )}
      {manager && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await post({
                  action: "wordpress.configure",
                  installation,
                  username,
                  applicationPassword: password,
                  confirmed: wpConfirmed,
                  expectedRevision: wp?.revision,
                });
                setPassword("");
                setUsername("");
                setPreview(null);
                setNotice(
                  "WordPress destination saved. Connection permission and delivery remain unverified.",
                );
              });
            }}
          >
            <fieldset disabled={disabled}>
              <legend>WordPress draft destination</legend>
              <label>
                Installation URL
                <input
                  required
                  type="url"
                  value={installation}
                  onChange={(e) => setInstallation(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label>
                Dedicated WordPress username
                <input
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                  maxLength={200}
                />
              </label>
              <label>
                Application password
                <input
                  required
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  maxLength={1024}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={wpConfirmed}
                  onChange={(e) => setWpConfirmed(e.target.checked)}
                />
                I control this installation on the verified site and chose a
                dedicated user with draft permission.
              </label>
              <button disabled={!wpConfirmed} type="submit">
                Save WordPress destination
              </button>
            </fieldset>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const value = await post({
                  action: "webhook.configure",
                  url: endpoint,
                  confirmed: receiverConfirmed,
                  eventTypes: [
                    ...(auditEvents ? ["audit.completed"] : []),
                    ...(reportEvents ? ["report.created"] : []),
                  ],
                  expectedRevision: webhook?.revision,
                });
                setSecret({ secret: value.secret, keyId: value.keyId });
                setNotice("Receiver saved. No test or event was sent.");
              });
            }}
          >
            <fieldset disabled={disabled}>
              <legend>Signed webhook receiver</legend>
              <label>
                HTTPS receiver URL
                <input
                  required
                  type="url"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  autoComplete="off"
                  maxLength={2048}
                />
              </label>
              <p>
                Use a URL without query credentials. Events contain resource
                IDs, scope and dates; they contain no raw page text.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={auditEvents}
                  onChange={(e) => setAuditEvents(e.target.checked)}
                />
                Save audit completion events
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={reportEvents}
                  onChange={(e) => setReportEvents(e.target.checked)}
                />
                Save report creation events
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={receiverConfirmed}
                  onChange={(e) => setReceiverConfirmed(e.target.checked)}
                />
                I control this receiver and will verify signatures, timestamps
                and event IDs before applying effects.
              </label>
              <button disabled={!receiverConfirmed} type="submit">
                Save webhook receiver
              </button>
            </fieldset>
          </form>
        </>
      )}
      {data?.destinations.map((destination) => (
        <section
          key={destination.id}
          aria-label={`${destination.kind === "WORDPRESS" ? "WordPress" : "Webhook"} saved destination`}
        >
          <h2>{destination.kind === "WORDPRESS" ? "WordPress" : "Webhook"}</h2>
          <p style={{ overflowWrap: "anywhere" }}>{destination.url}</p>
          <p>
            {destination.status === "CONFIGURED"
              ? "Configured; delivery unverified"
              : "Disconnected"}{" "}
            · revision {destination.revision}
          </p>
          {manager && destination.status === "CONFIGURED" && (
            <>
              <button
                type="button"
                disabled={!ready || busy}
                onClick={() =>
                  void act(async () => {
                    await post({
                      action: "disconnect",
                      destinationId: destination.id,
                      expectedRevision: destination.revision,
                    });
                    setPreview(null);
                    setSecret(null);
                    setNotice(
                      "Disconnected. Queued work is revoked and local credentials removed. Existing remote drafts and delivered events are unchanged.",
                    );
                  })
                }
              >
                Disconnect{" "}
                {destination.kind === "WORDPRESS" ? "WordPress" : "webhook"}
              </button>
              {destination.kind === "WEBHOOK" && (
                <>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      void act(async () => {
                        const value = await post({
                          action: "webhook.rotate",
                          destinationId: destination.id,
                          expectedRevision: destination.revision,
                        });
                        setSecret({ secret: value.secret, keyId: value.keyId });
                        setNotice(
                          "New receiver key saved. Previous key overlaps for at most 24 hours.",
                        );
                      })
                    }
                  >
                    Rotate receiver key
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      void act(async () => {
                        await post({
                          action: "webhook.test",
                          destinationId: destination.id,
                          idempotencyKey: crypto.randomUUID(),
                        });
                        setNotice(
                          "Test delivery intent saved in quarantine. No request was sent.",
                        );
                      })
                    }
                  >
                    Save test delivery intent
                  </button>
                </>
              )}
            </>
          )}
        </section>
      ))}
      {editable && wp?.status === "CONFIGURED" && (
        <section aria-label="Review WordPress draft">
          <h2>Review an exact draft revision</h2>
          <label>
            Saved page draft
            <select
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setPreview(null);
              }}
            >
              <option value="">Choose a draft</option>
              {drafts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title} · revision {d.revision}
                </option>
              ))}
            </select>
          </label>
          {!drafts.length && (
            <p>Create an evidence-backed page draft in Content first.</p>
          )}
          <button
            type="button"
            disabled={disabled || !selected}
            onClick={() =>
              void act(async () => {
                const params = new URLSearchParams({
                  ...scope,
                  action: "wordpress.preview",
                  destinationId: wp.id,
                  draftRevisionId: selected,
                });
                const response = await fetch(
                    `/api/integrations/handoffs?${params}`,
                    { cache: "no-store" },
                  ),
                  value = await response.json();
                if (!response.ok) throw Error(value.error);
                setPreview(value);
              })
            }
          >
            Review outgoing draft
          </button>
          {preview && (
            <>
              <h3>{preview.title}</h3>
              <p>
                Revision {preview.draftRevision} · status draft · destination{" "}
                {preview.destination.url}
              </p>
              <label>
                Literal draft text
                <textarea readOnly value={preview.sourceBody} rows={8} />
              </label>
              <p>
                Text is escaped into minimal paragraphs. No images, scripts or
                remote assets are loaded.
              </p>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void act(async () => {
                    try {
                      await post({
                        action: "wordpress.prepare",
                        destinationId: preview.destination.id,
                        draftRevisionId: preview.draftRevisionId,
                        expectedBodyHash: preview.hash,
                        expectedDestinationGeneration:
                          preview.destination.generation,
                        expectedDestinationUrl: preview.destination.url,
                        idempotencyKey: crypto.randomUUID(),
                      });
                    } catch (error) {
                      setPreview(null);
                      throw error;
                    }
                    setNotice(
                      "Draft handoff intent saved in quarantine. No WordPress request was sent.",
                    );
                    setPreview(null);
                  })
                }
              >
                Save reviewed draft handoff intent
              </button>
            </>
          )}
        </section>
      )}
      <section aria-label="Saved delivery history">
        <h2>Delivery history</h2>
        {data?.intents.length === 0 ? (
          <p>No saved handoffs yet.</p>
        ) : (
          <div
            style={{ overflowX: "auto" }}
            tabIndex={0}
            role="region"
            aria-label="Delivery history table"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">State</th>
                  <th scope="col">Attempts</th>
                  <th scope="col">Saved</th>
                  <th scope="col">Next action</th>
                </tr>
              </thead>
              <tbody>
                {data?.intents.map((item) => (
                  <tr key={item.id}>
                    <td>{item.kind}</td>
                    <td>
                      {item.mode === "QUARANTINED"
                        ? "Quarantined · "
                        : item.mode === "FIXTURE"
                          ? "Synthetic fixture · "
                          : ""}
                      {item.state}
                    </td>
                    <td>{item.attempt}</td>
                    <td>{new Date(item.created_at).toLocaleString()}</td>
                    <td>
                      {item.state === "UNRESOLVED" ? (
                        "Inspect WordPress manually. Do not create a replacement automatically."
                      ) : item.editor_url ? (
                        <a
                          href={item.editor_url}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open confirmed WordPress draft
                        </a>
                      ) : item.mode === "QUARANTINED" ? (
                        "Delivery requires operator qualification."
                      ) : (
                        (item.last_code ?? "No action required")
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
