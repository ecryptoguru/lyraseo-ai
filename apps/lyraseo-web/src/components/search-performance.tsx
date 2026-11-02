"use client";
import { useEffect, useState } from "react";
import type { SearchOpportunity, SearchEvidenceRow } from "@lyraseo/visibility";
type Snapshot = {
  id: string;
  startDate: string;
  endDate: string;
  shape: string;
  status: string;
  importedAt: string;
  rowCount: number;
  rowsTruncated: boolean;
  rows: SearchEvidenceRow[];
};
type SearchState = {
  connection: { property: string | null } | null;
  imports: Array<{
    id: string;
    property: string;
    startDate: string;
    endDate: string;
    shape: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    failure: string | null;
    recoverable: boolean;
    snapshotStatus: string | null;
  }>;
  snapshots: Snapshot[];
  coverage: string;
  opportunities: SearchOpportunity[];
};
const errors: Record<string, string> = {
  GOOGLE_UNAVAILABLE:
    "Google Search Console is not configured. Ask the pilot operator to complete the Google connection settings.",
  GOOGLE_DISCONNECTED:
    "Connect Search Console to import your site’s search evidence.",
  GOOGLE_RECONNECT_REQUIRED:
    "Google access expired or was revoked. Reconnect Search Console to continue.",
  GOOGLE_PROPERTY_REQUIRED:
    "Choose the verified property for this site before importing.",
  GOOGLE_PROPERTY_FORBIDDEN:
    "Google no longer grants access to this property. Reconnect with an authorized account.",
  GOOGLE_CONNECTION_CHANGED:
    "The connection changed during import. Check the selected property and retry.",
  GOOGLE_IMPORT_RUNNING:
    "An import is already running. Refresh import status to check it; retry its saved window only after it fails or its lease expires.",
  GOOGLE_PERMISSION_REQUIRED:
    "Google access is insufficient. Reconnect Search Console with an authorized account.",
};
export function SearchPerformance({
  workspaceId,
  siteId,
  editable,
  collectionEnabled = true,
}: {
  collectionEnabled?: boolean;
  workspaceId: string;
  siteId: string;
  editable: boolean;
}) {
  const [state, setState] = useState<SearchState | null>(null),
    [message, setMessage] = useState("Loading search evidence…"),
    [busy, setBusy] = useState(false);
  const [properties, setProperties] = useState<
    Array<{ siteUrl: string; permissionLevel: string }>
  >([]);
  const [selectedId, setSelectedId] = useState("");
  const today = new Date();
  today.setUTCDate(today.getUTCDate() - 3);
  const defaultEnd = today.toISOString().slice(0, 10);
  today.setUTCDate(today.getUTCDate() - 89);
  const [startDate, setStartDate] = useState(today.toISOString().slice(0, 10)),
    [endDate, setEndDate] = useState(defaultEnd);
  const query = `workspaceId=${encodeURIComponent(workspaceId)}&siteId=${encodeURIComponent(siteId)}`;
  async function request(url: string, body?: Record<string, unknown>) {
    const response = await fetch(
      url,
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
        errors[value.error] ??
          "Search evidence is unavailable. Check your connection and retry.",
      );
    return value;
  }
  async function refresh() {
    const data = await request(`/api/search?${query}`);
    setState(data);
    return data;
  }
  useEffect(() => {
    let active = true;
    fetch(`/api/search?${query}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (active) {
          setState(data);
          setMessage(
            data.connection
              ? "Select a date window or inspect a saved import."
              : "Connect Search Console when you’re ready. Site audits remain available independently.",
          );
        }
      })
      .catch(() => {
        if (active)
          setMessage(
            "Search evidence could not load. Refresh this page to retry.",
          );
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
      // A failed POST may have saved a failure receipt. Read it without dispatching work.
      await refresh().catch(() => {});
      setMessage(
        error instanceof Error
          ? error.message
          : "Search evidence is temporarily unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }
  const selected =
    state?.snapshots.find((snapshot) => snapshot.id === selectedId) ??
    state?.snapshots[0];
  return (
    <>
      {!collectionEnabled && (
        <p className="notice" role="status">
          This capability is paused. Saved evidence remains readable; safe
          recovery controls remain available.
        </p>
      )}
      <p>
        <a
          href={`/app/sites/${encodeURIComponent(siteId)}/analytics?workspaceId=${encodeURIComponent(workspaceId)}`}
        >
          Attach optional GA4 landing-page outcomes
        </a>
      </p>
      <section className="pilot-card" aria-labelledby="search-connection">
        <h2 id="search-connection">Search Console connection</h2>
        <p>
          {state?.connection?.property
            ? `Selected property ${state.connection.property}`
            : state?.connection
              ? "Google connected. Choose the exact verified property for this site."
              : "Read-only access to your own Google Search Console data."}
        </p>
        {editable && (
          <div className="pilot-tabs">
            <button
              className="button button-primary"
              disabled={busy || !collectionEnabled}
              onClick={() =>
                void perform(async () => {
                  const result = await request("/api/integrations/google", {
                    action: "connect",
                  });
                  const url = new URL(result.url);
                  if (url.origin !== "https://accounts.google.com")
                    throw new Error(
                      "Google sign-in destination is unavailable.",
                    );
                  window.location.assign(url.href);
                })
              }
            >
              Connect Search Console
            </button>
            {state?.connection && (
              <>
                <button
                  className="button button-secondary"
                  disabled={busy || !collectionEnabled}
                  onClick={() =>
                    void perform(async () => {
                      const result = await request("/api/integrations/google", {
                        action: "discover",
                      });
                      setProperties(result.properties);
                      setMessage("Choose a property with verified access.");
                    })
                  }
                >
                  Load available properties
                </button>
                <button
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await request("/api/integrations/google", {
                        action: "disconnect",
                      });
                      setProperties([]);
                      await refresh();
                      setMessage(
                        "Google disconnected and imported search data removed.",
                      );
                    })
                  }
                >
                  Disconnect and remove imported data
                </button>
              </>
            )}
          </div>
        )}
        {!!properties.length && editable && collectionEnabled && (
          <>
            <label htmlFor="google-property">Verified property</label>
            <select
              className="audit-input"
              id="google-property"
              disabled={busy}
              value=""
              onChange={(event) => {
                const property = event.target.value;
                if (property)
                  void perform(async () => {
                    await request("/api/integrations/google", {
                      action: "select",
                      property,
                    });
                    await refresh();
                    setMessage("Search property selected.");
                  });
              }}
            >
              <option value="">Choose property</option>
              {properties.map((property) => (
                <option key={property.siteUrl} value={property.siteUrl}>
                  {property.siteUrl}
                </option>
              ))}
            </select>
          </>
        )}
        <p role="status" aria-live="polite">
          {message}
        </p>
      </section>
      {editable && collectionEnabled && state?.connection?.property && (
        <section className="pilot-card" aria-labelledby="search-import">
          <h2 id="search-import">Import a search window</h2>
          <p>
            Use provider calendar dates. The default window covers 90 days
            ending three days ago. Each dimension is retained separately.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                for (const shape of ["page", "query", "date", "query,page"]) {
                  setMessage(
                    `Importing ${shape.replace(",", " and ")} evidence…`,
                  );
                  await request("/api/search", { startDate, endDate, shape });
                }
                await refresh();
                setMessage(
                  "Search window saved. Previously imported windows are reused.",
                );
              });
            }}
          >
            <label htmlFor="search-start">Start date</label>
            <input
              className="audit-input"
              id="search-start"
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              required
              disabled={busy}
            />
            <label htmlFor="search-end">End date</label>
            <input
              className="audit-input"
              id="search-end"
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              required
              disabled={busy}
            />
            <button className="button button-primary" disabled={busy}>
              Import selected window
            </button>
          </form>
        </section>
      )}
      <section className="pilot-card" aria-labelledby="search-import-history">
        <h2 id="search-import-history">Recent import status</h2>
        <p>
          Latest 20 saved windows from the last 13 months. Status checks only
          read saved data. Explicit imports use free Google Search Console API
          quota; no paid AI calls are used. Saved evidence remains available
          while another window is running or has failed.
        </p>
        <button
          className="button button-secondary"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await refresh();
              setMessage(
                "Saved import status refreshed. No import was started.",
              );
            })
          }
        >
          Refresh import status
        </button>
        {state && !state.imports?.length && <p>No saved import status yet.</p>}
        <ul className="audit-findings">
          {state?.imports?.map((receipt) => (
            <li key={receipt.id}>
              <h3>
                {receipt.startDate.slice(0, 10)}–{receipt.endDate.slice(0, 10)}
                {" · "}
                {receipt.shape.slice(0, 20)}
              </h3>
              <p className="audit-url">{receipt.property.slice(0, 2048)}</p>
              <p>
                {receipt.status === "running"
                  ? receipt.recoverable
                    ? "Lease expired — import stalled and can be retried. No new snapshot was published by this attempt."
                    : "Running — this window has not published new evidence yet. Refresh status to check progress."
                  : receipt.status === "failed"
                    ? receipt.failure === "GOOGLE_IMPORT_LEASE_EXPIRED"
                      ? "Lease expired — import can be retried."
                      : "Failed — this attempt did not publish new evidence."
                    : receipt.status === "complete"
                      ? receipt.snapshotStatus === "partial"
                        ? "Completed with partial coverage — the import processing limit was reached."
                        : "Completed — inspect saved evidence and its coverage below. Empty provider rows do not prove zero traffic."
                      : "Status unavailable. Refresh saved status to check again."}
              </p>
              {receipt.status === "failed" && (
                <p>
                  {errors[receipt.failure ?? ""] ??
                    "Check your Google connection, then explicitly retry this window when ready."}
                </p>
              )}
              <p>
                Started {new Date(receipt.startedAt).toLocaleString()}
                {receipt.completedAt &&
                  ` · Finished ${new Date(receipt.completedAt).toLocaleString()}`}
              </p>
              {receipt.recoverable &&
                (!collectionEnabled ? (
                  <p>
                    Collection is paused. Retry is available when collection
                    resumes.
                  </p>
                ) : !editable ? (
                  <p>
                    Ask a workspace manager to reconnect or retry this window.
                  </p>
                ) : state.connection?.property !== receipt.property ? (
                  <p>
                    Connect and select this receipt’s verified property before
                    retrying.
                  </p>
                ) : (
                  <button
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        setStartDate(receipt.startDate);
                        setEndDate(receipt.endDate);
                        setMessage("Retrying the saved window and dimension…");
                        await request("/api/search", {
                          startDate: receipt.startDate,
                          endDate: receipt.endDate,
                          shape: receipt.shape,
                        });
                        await refresh();
                        setMessage(
                          "Saved window retry completed. Inspect its status and coverage.",
                        );
                      })
                    }
                  >
                    Retry this window
                  </button>
                ))}
            </li>
          ))}
        </ul>
      </section>
      <section className="pilot-card" aria-labelledby="search-opportunities">
        <h2 id="search-opportunities">Opportunities to inspect</h2>
        <p>
          {state?.coverage ?? "Search evidence will appear after an import."}
        </p>
        {state && !state.opportunities.length && (
          <p>
            No opportunities meet the current observed-data rules. Import a
            supported window or inspect your page evidence below.
          </p>
        )}
        <ul className="audit-findings">
          {state?.opportunities.map((item, index) => (
            <li key={`${item.kind}:${item.query}:${item.page}:${index}`}>
              <h3>{item.kind.replaceAll("-", " ")}</h3>
              <p>{item.query}</p>
              <p className="audit-url">{item.page}</p>
              <p>{item.explanation}</p>
              <details>
                <summary>Source evidence and thresholds</summary>
                <pre className="audit-url">
                  {JSON.stringify(item.evidence, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      </section>
      {!!state?.snapshots.length && (
        <section className="pilot-card" aria-labelledby="search-data">
          <h2 id="search-data">Saved search evidence</h2>
          <label htmlFor="search-snapshot">Import and dimension</label>
          <select
            id="search-snapshot"
            className="audit-input"
            value={selected?.id ?? ""}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {state.snapshots.map((snapshot) => (
              <option key={snapshot.id} value={snapshot.id}>
                {snapshot.startDate}–{snapshot.endDate} · {snapshot.shape} ·{" "}
                {snapshot.status}
              </option>
            ))}
          </select>
          <p>
            {selected?.rowCount ?? selected?.rows.length} available rows ·{" "}
            {selected?.rowsTruncated
              ? "Showing the first 100 rows"
              : "All retained preview rows shown"}{" "}
            · Imported{" "}
            {selected && new Date(selected.importedAt).toLocaleString()}
          </p>
          <div
            className="audit-table"
            tabIndex={0}
            role="region"
            aria-label="Search evidence table"
          >
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Clicks</th>
                  <th>Impressions</th>
                  <th>CTR</th>
                  <th>Position</th>
                </tr>
              </thead>
              <tbody>
                {selected?.rows.map((row, index) => (
                  <tr key={index}>
                    <td className="audit-url">{row.keys.join(" · ")}</td>
                    <td>{row.clicks}</td>
                    <td>{row.impressions}</td>
                    <td>
                      {row.ctr === null
                        ? "Unavailable"
                        : `${(row.ctr * 100).toFixed(2)}%`}
                    </td>
                    <td>
                      {row.position === null
                        ? "Unavailable"
                        : row.position.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
