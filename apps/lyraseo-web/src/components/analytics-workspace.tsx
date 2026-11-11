"use client";
import { useEffect, useState } from "react";
type Property = {
  property: string;
  displayName: string;
  timeZone: string;
  streams: Array<{ streamId: string; displayName: string; defaultUri: string }>;
};
type Row = {
  date: string;
  rawLandingPage: string;
  normalizedUrl: string | null;
  unavailableReason: string | null;
  sessions: number;
  engagedSessions: number;
  sessionKeyEventRate: number | null;
};
type Snapshot = {
  id: string;
  property: string;
  streamId: string;
  timeZone: string;
  startDate: string;
  endDate: string;
  status: string;
  failure: string | null;
  rows: Row[];
  diagnostics: Record<string, unknown>;
  rowCount: number;
  displayLimited?: boolean;
  stale: boolean;
};
type Saved = {
  configured: boolean;
  connection: {
    property: string | null;
    streamId: string | null;
    timeZone: string | null;
    status: string;
  } | null;
  properties: Property[];
  snapshots: Snapshot[];
  coverage: string;
  opportunityOutcomes: Array<{
    query: string;
    page: string;
    explanation: string;
    conversionEvidence: {
      status: string;
      reason?: string;
      label?: string;
      rows?: Row[];
    };
  }>;
};
const reasons: Record<string, string> = {
  not_connected: "No matching retained GA4 import",
  scope_mismatch: "Property, stream or site scope differs",
  incompatible_window: "Date windows or timezones differ",
  restricted_or_partial_data: "Data is partial, restricted or provisional",
  missing_key_event_setup: "No configured key-event evidence",
  no_matching_page: "No exact landing-page match",
};
export function AnalyticsWorkspace({
  workspaceId,
  siteId,
  manageable,
  collectionEnabled = true,
}: {
  collectionEnabled?: boolean;
  workspaceId: string;
  siteId: string;
  manageable: boolean;
}) {
  const [saved, setSaved] = useState<Saved | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("Loading saved analytics…");
  const [property, setProperty] = useState(""),
    [streamId, setStreamId] = useState(""),
    [selectedId, setSelectedId] = useState("");
  const [dates] = useState(() => {
    const end = new Date();
    end.setUTCDate(end.getUTCDate() - 3);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 27);
    return {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    };
  });
  const [startDate, setStartDate] = useState(dates.start),
    [endDate, setEndDate] = useState(dates.end);
  const query = `workspaceId=${encodeURIComponent(workspaceId)}&siteId=${encodeURIComponent(siteId)}`;
  async function request(path: string, body?: Record<string, unknown>) {
    const response = await fetch(
      body ? path : `${path}?${query}`,
      body
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId, siteId, ...body }),
          }
        : { cache: "no-store" },
    );
    const value = await response.json();
    if (!response.ok)
      throw new Error(
        value.error === "ANALYTICS_RECONNECT_REQUIRED"
          ? "Google access was revoked or expired. Reconnect Analytics to import again."
          : value.error === "ANALYTICS_SCOPE_ERROR"
            ? "This account no longer has the required Analytics property permission."
            : value.error === "ANALYTICS_UNAVAILABLE"
              ? "Analytics credentials are not configured. Other product features remain available."
              : value.error === "ANALYTICS_IMPORT_RUNNING"
                ? "This window is already importing. Refresh saved data shortly."
                : "Analytics request failed. Check the selected property and date range, then retry.",
      );
    return value;
  }
  async function refresh() {
    const value = await request("/api/analytics");
    setSaved(value);
    return value as Saved;
  }
  useEffect(() => {
    let active = true;
    fetch(`/api/analytics?${query}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Saved Analytics could not load. Refresh to retry.");
        return response.json();
      })
      .then((value) => {
        if (active) {
          setSaved(value);
          setMessage(
            value.configured
              ? "Choose an explicit property and web stream, then import a bounded date window."
              : "Optional Analytics connection is not configured. Saved evidence remains readable.",
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
    try {
      await work();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to update Analytics.",
      );
    } finally {
      setBusy(false);
    }
  }
  const selected =
    saved?.snapshots.find((snapshot) => snapshot.id === selectedId) ??
    saved?.snapshots[0];
  return (
    <>
      {!collectionEnabled && (
        <p className="notice" role="status">
          This capability is paused. Saved evidence remains readable; safe
          recovery controls remain available.
        </p>
      )}
      <section className="pilot-card" aria-labelledby="analytics-connection">
        <h2 id="analytics-connection">Optional Google Analytics connection</h2>
        <p>
          Read-only organic landing-page session outcomes. Search Console
          queries are not attributed to individual GA4 sessions. Missing pages
          never inherit homepage outcomes.
        </p>
        <p>
          {saved?.connection
            ? `Connection: ${saved.connection.status} · ${saved.connection.property ?? "Property not selected"} · stream ${saved.connection.streamId ?? "not selected"} · timezone ${saved.connection.timeZone ?? "not selected"}`
            : "No Analytics connection."}
        </p>
        {manageable && (
          <div className="pilot-tabs">
            <button
              className="button button-primary"
              disabled={busy || !collectionEnabled || !saved?.configured}
              onClick={() =>
                void perform(async () => {
                  const result = await request("/api/integrations/analytics", {
                    action: "connect",
                  });
                  const url = new URL(result.url);
                  if (url.origin !== "https://accounts.google.com")
                    throw new Error(
                      "Google consent destination is unavailable.",
                    );
                  window.location.assign(url.href);
                })
              }
            >
              Connect Analytics
            </button>
            {saved?.connection && (
              <>
                <button
                  className="button button-secondary"
                  disabled={busy || !collectionEnabled || !saved.configured}
                  onClick={() =>
                    void perform(async () => {
                      const result = await request(
                        "/api/integrations/analytics",
                        { action: "discover" },
                      );
                      setSaved({ ...saved, properties: result.properties });
                      setMessage(
                        "Available properties loaded. Choose the exact site’s web stream.",
                      );
                    })
                  }
                >
                  Load properties and streams
                </button>
                <button
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await request("/api/integrations/analytics", {
                        action: "disconnect",
                      });
                      await refresh();
                      setProperty("");
                      setStreamId("");
                      setMessage(
                        "Analytics disconnected and imported datasets removed. Search Console access is unchanged.",
                      );
                    })
                  }
                >
                  Disconnect and remove Analytics data
                </button>
              </>
            )}
          </div>
        )}
        {manageable && collectionEnabled && !!saved?.properties.length && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                await request("/api/integrations/analytics", {
                  action: "select",
                  property,
                  streamId,
                });
                await refresh();
                setMessage(
                  "Exact property and stream selected. Previous imports remain historical evidence.",
                );
              });
            }}
          >
            <label htmlFor="analytics-property">Analytics property</label>
            <select
              id="analytics-property"
              className="audit-input"
              value={property}
              disabled={busy}
              required
              onChange={(event) => {
                setProperty(event.target.value);
                setStreamId("");
              }}
            >
              <option value="">Choose property</option>
              {saved.properties.map((p) => (
                <option key={p.property} value={p.property}>
                  {p.displayName} · {p.timeZone}
                </option>
              ))}
            </select>
            <label htmlFor="analytics-stream">Web stream</label>
            <select
              id="analytics-stream"
              className="audit-input"
              value={streamId}
              disabled={busy || !property}
              required
              onChange={(event) => setStreamId(event.target.value)}
            >
              <option value="">Choose matching web stream</option>
              {saved.properties
                .find((p) => p.property === property)
                ?.streams.map((stream) => (
                  <option key={stream.streamId} value={stream.streamId}>
                    {stream.displayName} · {stream.defaultUri}
                  </option>
                ))}
            </select>
            <button
              className="button button-secondary"
              disabled={busy || !property || !streamId}
            >
              Use property and stream
            </button>
          </form>
        )}
        <p role="status" aria-live="polite">
          {message}
        </p>
      </section>
      {manageable && collectionEnabled && (
        <section className="pilot-card" aria-labelledby="analytics-import">
          <h2 id="analytics-import">Import a bounded window</h2>
          <p>
            Up to 90 calendar days and 10,000 rows. This explicit Google report
            request uses API quota and does not consume a paid-provider
            partition. Reopening a saved window makes no report request.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const result = await request("/api/analytics", {
                  startDate,
                  endDate,
                });
                await refresh();
                setSelectedId(result.id);
                setMessage(`Saved Analytics window: ${result.status}.`);
              });
            }}
          >
            <label htmlFor="analytics-start">Start date</label>
            <input
              id="analytics-start"
              className="audit-input"
              type="date"
              value={startDate}
              disabled={busy}
              required
              onChange={(event) => setStartDate(event.target.value)}
            />
            <label htmlFor="analytics-end">End date</label>
            <input
              id="analytics-end"
              className="audit-input"
              type="date"
              value={endDate}
              disabled={busy}
              required
              onChange={(event) => setEndDate(event.target.value)}
            />
            <button
              className="button button-primary"
              disabled={
                busy ||
                !saved?.configured ||
                !saved.connection?.property ||
                !saved.connection?.streamId
              }
            >
              Import organic landing pages
            </button>
          </form>
        </section>
      )}
      <section className="pilot-card" aria-labelledby="analytics-outcomes">
        <h2 id="analytics-outcomes">Outcomes alongside search opportunities</h2>
        <p>{saved?.coverage}</p>
        <p>
          Search Console uses Los Angeles calendar dates. A GA4 property in a
          different timezone keeps its own window; those results are not
          combined.
        </p>
        {!saved?.opportunityOutcomes.length && (
          <p>No saved search opportunities are available to match.</p>
        )}
        <ul className="audit-history">
          {saved?.opportunityOutcomes.map((item, index) => (
            <li key={index}>
              <h3>{item.query || "Page opportunity"}</h3>
              <p className="audit-url">{item.page}</p>
              <p>{item.explanation}</p>
              {item.conversionEvidence.status === "available" ? (
                <>
                  <p>{item.conversionEvidence.label}</p>
                  <details>
                    <summary>Exact-page observed session context</summary>
                    <pre className="audit-url">
                      {JSON.stringify(item.conversionEvidence.rows, null, 2)}
                    </pre>
                  </details>
                </>
              ) : (
                <p>
                  Outcome evidence unavailable:{" "}
                  {reasons[item.conversionEvidence.reason ?? ""] ??
                    item.conversionEvidence.reason ??
                    "No matching data"}
                  .
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="pilot-card" aria-labelledby="analytics-evidence">
        <h2 id="analytics-evidence">Saved landing-page evidence</h2>
        {!saved?.snapshots.length && (
          <p>
            No Analytics imports yet. This is unmeasured, not zero sessions.
          </p>
        )}
        {!!saved?.snapshots.length && (
          <>
            <label htmlFor="analytics-snapshot">Saved import window</label>
            <select
              id="analytics-snapshot"
              className="audit-input"
              value={selected?.id ?? ""}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {saved.snapshots.map((snapshot) => (
                <option key={snapshot.id} value={snapshot.id}>
                  {snapshot.startDate}–{snapshot.endDate} · {snapshot.status} ·{" "}
                  {snapshot.timeZone}
                </option>
              ))}
            </select>
          </>
        )}
        {selected && (
          <>
            <p>
              {selected.startDate}–{selected.endDate} · {selected.timeZone} ·{" "}
              {selected.status}
              {selected.stale ? " · stale" : ""} · {selected.rowCount} saved
              rows{selected.displayLimited ? " (first 100 shown)" : ""}
            </p>
            {selected.failure && (
              <p>
                Import failure: {selected.failure}. Retry this window after
                resolving the connection.
              </p>
            )}
            <div
              className="audit-table"
              role="region"
              aria-label="Organic landing-page evidence table"
              tabIndex={0}
            >
              <table>
                <caption>
                  Organic Search session rows — rates are not averaged
                </caption>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Measured landing page</th>
                    <th>Sessions</th>
                    <th>Engaged sessions</th>
                    <th>Session key-event rate</th>
                    <th>Match status</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.rows.map((row, index) => (
                    <tr key={index}>
                      <td>{row.date}</td>
                      <td className="audit-url">{row.rawLandingPage}</td>
                      <td>{row.sessions}</td>
                      <td>{row.engagedSessions}</td>
                      <td>
                        {row.sessionKeyEventRate === null
                          ? "Unavailable"
                          : `${(row.sessionKeyEventRate * 100).toFixed(2)}%`}
                      </td>
                      <td>{row.unavailableReason ?? "Exact page"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details>
              <summary>Source scope and import limitations</summary>
              <p>
                Property {selected.property} · stream {selected.streamId}
              </p>
              <pre className="audit-url">
                {JSON.stringify(selected.diagnostics, null, 2)}
              </pre>
            </details>
          </>
        )}
      </section>
    </>
  );
}
