"use client";
import { useEffect, useId, useState } from "react";
import { useClientReady } from "./use-client-ready";
import type { SearchOpportunity } from "@lyraseo/visibility";
type Saved = {
  id: string;
  createdAt: string;
  request: {
    keywords: string[];
    page: string;
    query: string;
    market: { country: string; language: string; support: string };
    opportunity: { evidence: Record<string, unknown> };
  };
  result: null | {
    source: string;
    currency: string | null;
    method: string;
    collectedAt: string;
    rows: {
      keyword: string;
      searchVolume: number | null;
      cpc: string | null;
      competition: string | null;
    }[];
  };
};
export function KeywordEnrichment({
  workspaceId,
  siteId,
  editable,
  collectionEnabled,
  opportunities,
}: {
  workspaceId: string;
  siteId: string;
  editable: boolean;
  collectionEnabled: boolean;
  opportunities: SearchOpportunity[];
}) {
  const id = useId(),
    ready = useClientReady(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("Loading saved keyword selections…"),
    [saved, setSaved] = useState<Saved[]>([]),
    [selected, setSelected] = useState(""),
    [keywords, setKeywords] = useState("");
  const eligible = opportunities.filter(
    (x) =>
      typeof x.evidence.snapshotId === "string" &&
      x.kind !== "demand-and-audit",
  );
  const query = new URLSearchParams({ workspaceId, siteId }).toString();
  useEffect(() => {
    let active = true;
    fetch("/api/keywords?" + query, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw Error();
        const result = await response.json();
        if (active) {
          setSaved(result.selections);
          setMessage(
            "Select an opportunity and review the exact keywords. No provider request has been made.",
          );
        }
      })
      .catch(() => {
        if (active)
          setMessage(
            "Saved keyword selections could not load. Refresh to retry.",
          );
      });
    return () => {
      active = false;
    };
  }, [query]);
  async function post(body: Record<string, unknown>) {
    const response = await fetch("/api/keywords", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, siteId, ...body }),
    });
    const result = await response.json();
    if (!response.ok)
      throw Error(result.error ?? "Keyword selection is unavailable.");
    return result;
  }
  return (
    <section className="pilot-card" aria-labelledby={id + "-heading"}>
      <h2 id={id + "-heading"}>Keyword enrichment</h2>
      <p>
        Review keywords for one search opportunity. The requested market is
        English / India; provider support, pricing and account access remain
        unconfirmed. No provider request is available until these checks pass.
      </p>
      {editable && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const item = eligible[Number(selected)];
            if (!item || selected === "") return;
            setBusy(true);
            void (async () => {
              try {
                const selection = await post({
                  action: "select",
                  snapshotId: item.evidence.snapshotId,
                  kind: item.kind,
                  query: item.query,
                  page: item.page,
                  keywords: keywords
                    .split("\n")
                    .map((x) => x.trim())
                    .filter(Boolean),
                  country: "IN",
                  language: "en",
                  idempotencyKey: crypto.randomUUID(),
                });
                const quote = await post({
                  action: "quote",
                  selectionId: selection.id,
                });
                setMessage(quote.reason + " No paid request was created.");
                const response = await fetch("/api/keywords?" + query, {
                  cache: "no-store",
                });
                if (response.ok) setSaved((await response.json()).selections);
              } catch (error) {
                setMessage(
                  error instanceof Error
                    ? error.message
                    : "Keyword selection is unavailable.",
                );
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          <label htmlFor={id + "-opportunity"}>Search opportunity</label>
          <select
            className="audit-input"
            id={id + "-opportunity"}
            value={selected}
            disabled={!ready || busy || !collectionEnabled}
            required
            onChange={(event) => {
              setSelected(event.target.value);
              setKeywords(eligible[Number(event.target.value)]?.query ?? "");
            }}
          >
            <option value="">Choose an opportunity</option>
            {eligible.map((item, index) => (
              <option key={index} value={index}>
                {item.query || item.page} · {item.kind.replaceAll("-", " ")}
              </option>
            ))}
          </select>
          <label htmlFor={id + "-keywords"}>
            Selected keywords, one per line (up to 20)
          </label>
          <textarea
            className="audit-input"
            id={id + "-keywords"}
            value={keywords}
            maxLength={2020}
            rows={3}
            required
            disabled={!ready || busy || !collectionEnabled}
            onChange={(event) => setKeywords(event.target.value)}
          />
          <button
            className="button button-secondary"
            disabled={!ready || busy || !collectionEnabled || selected === ""}
          >
            Save selection and check availability
          </button>
        </form>
      )}
      <p role="status" aria-live="polite">
        {message}
      </p>
      {!editable && (
        <p>
          Ask an editor to prepare a keyword selection. Saved results remain
          read-only.
        </p>
      )}
      {!collectionEnabled && (
        <p>Keyword preparation is paused. Saved evidence remains available.</p>
      )}
      {ready && saved.length === 0 && <p>No saved keyword selections yet.</p>}
      <ul className="audit-findings">
        {saved.map((item) => (
          <li key={item.id}>
            <h3>{item.request.keywords.join(", ")}</h3>
            <p className="audit-url">{item.request.page}</p>
            <p>
              Requested market: English / India · saved{" "}
              {new Date(item.createdAt).toLocaleString()}
            </p>
            {item.result ? (
              <>
                <p>
                  {item.result.source} · {item.result.method} · collected{" "}
                  {new Date(item.result.collectedAt).toLocaleString()}
                </p>
                <ul>
                  {item.result.rows.map((row) => (
                    <li key={row.keyword}>
                      {row.keyword}: search volume{" "}
                      {row.searchVolume ?? "unknown"}; CPC{" "}
                      {row.cpc === null
                        ? "unknown"
                        : (item.result?.currency ?? "currency unknown") +
                          " " +
                          row.cpc}
                      ; advertiser competition {row.competition ?? "unknown"}.
                    </li>
                  ))}
                </ul>
                <p>
                  Saved results are reused when reopened. Advertiser competition
                  does not measure organic ranking difficulty.
                </p>
              </>
            ) : (
              <p>
                Awaiting provider qualification. No quote, charge or collected
                metrics.
              </p>
            )}
            <details>
              <summary>Saved opportunity evidence</summary>
              <pre className="audit-url">
                {JSON.stringify(item.request.opportunity.evidence, null, 2)}
              </pre>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
