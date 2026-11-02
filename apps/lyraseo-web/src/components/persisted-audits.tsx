"use client";
import { useEffect, useState } from "react";
import type { AuditEvaluation } from "@lyraseo/visibility";

type Summary = { id: string; status: string; createdAt: string };
type SavedRun = Summary & {
  manifest: string[];
  evaluation: AuditEvaluation | null;
  declarations?: { contextRevision?: number };
  actions?: Array<{
    id: string;
    ruleId: string;
    disposition: string;
    reason: string;
  }>;
  pages: Array<{
    requestedUrl: string;
    provenance: { error?: string; sha256?: string; acquiredAt?: string };
  }>;
};
export function PersistedAudits({
  workspaceId,
  siteId,
  origin,
  editable,
  collectionEnabled = true,
  enabled,
}: {
  collectionEnabled?: boolean;
  workspaceId: string;
  siteId: string;
  origin: string;
  editable: boolean;
  enabled: boolean;
}) {
  const [runs, setRuns] = useState<Summary[]>([]),
    [selected, setSelected] = useState<SavedRun | null>(null);
  const [message, setMessage] = useState("Loading audit history…"),
    [busy, setBusy] = useState(false);
  const [manifest, setManifest] = useState(`${origin}/`),
    [reason, setReason] = useState("");
  const [comparison, setComparison] = useState<string>("");
  const base = `/api/audits?workspaceId=${encodeURIComponent(workspaceId)}&siteId=${encodeURIComponent(siteId)}`;
  async function read(url: string, options?: RequestInit) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error ?? "Audit service unavailable.");
    return data;
  }
  const send = (action: string, extra: Record<string, unknown>) =>
    read("/api/audits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, workspaceId, siteId, ...extra }),
    });
  useEffect(() => {
    let active = true;
    fetch(base, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (active) {
          setRuns(data);
          setMessage(
            data.length
              ? "Choose an audit to inspect its evidence."
              : "Your first saved audit will appear here.",
          );
        }
      })
      .catch(() => {
        if (active)
          setMessage(
            "Audit history could not load. Refresh this page to retry.",
          );
      });
    return () => {
      active = false;
    };
  }, [base]);
  async function advance(auditId: string) {
    let run: SavedRun;
    do {
      run = await send("step", { auditId });
      setSelected(run);
      setMessage(
        `${run.pages.length} of ${run.manifest.length} pages captured.`,
      );
    } while (run.status === "QUEUED");
    setRuns(await read(base));
    setMessage("Audit saved. Inspect findings and unavailable evidence below.");
  }
  async function execute(work: () => Promise<void>) {
    setBusy(true);
    setComparison("");
    try {
      await work();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to continue. Saved checkpoints remain available.",
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
      <section className="pilot-card" aria-labelledby="audit-create">
        <h2 id="audit-create">Audit selected pages</h2>
        <p>
          Original HTML checks include titles, canonical declarations and
          indexing directives. Rendered visibility and an overall readiness
          score await complete evidence.
        </p>
        {editable && collectionEnabled && enabled ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void execute(async () => {
                const run = await send("create", {
                  idempotencyKey: crypto.randomUUID(),
                  manifest: manifest
                    .split(/\r?\n/)
                    .map((value) => value.trim())
                    .filter(Boolean),
                });
                setRuns(await read(base));
                await advance(run.id);
              });
            }}
          >
            <label htmlFor="audit-pages">
              Confirm up to 25 pages, one URL per line. Include the homepage.
            </label>
            <textarea
              className="audit-input"
              id="audit-pages"
              rows={5}
              value={manifest}
              onChange={(event) => setManifest(event.target.value)}
              disabled={busy}
              required
            />
            <button className="button button-primary" disabled={busy}>
              {busy ? "Capturing evidence…" : "Confirm pages and start audit"}
            </button>
          </form>
        ) : (
          <p>
            {!collectionEnabled
              ? "Audit collection and review are paused. Saved evidence can still be inspected and exported."
              : editable
                ? "Local raw audits require operator configuration and verified private access."
                : "Your site access allows viewing and exporting saved audits."}
          </p>
        )}
        <p role="status" aria-live="polite">
          {message}
        </p>
      </section>
      <section className="pilot-card" aria-labelledby="audit-history">
        <h2 id="audit-history">Saved audit history</h2>
        <ul className="audit-history">
          {runs.map((run) => (
            <li key={run.id}>
              <button
                className="button button-secondary"
                disabled={busy}
                aria-pressed={selected?.id === run.id}
                onClick={() =>
                  void execute(async () => {
                    setSelected(
                      await read(
                        `${base}&auditId=${encodeURIComponent(run.id)}`,
                      ),
                    );
                    setMessage("Saved evidence loaded.");
                  })
                }
              >
                {new Date(run.createdAt).toLocaleString()} ·{" "}
                {run.status.toLowerCase()}
              </button>
            </li>
          ))}
        </ul>
      </section>
      {selected && (
        <section className="pilot-card" aria-labelledby="audit-results">
          <h2 id="audit-results">Audit evidence</h2>
          <p>
            {selected.pages.length} of {selected.manifest.length} selected pages
            captured · {selected.status.toLowerCase()}
          </p>
          {editable && ["QUEUED", "RUNNING"].includes(selected.status) && (
            <div className="pilot-tabs">
              <button
                className="button button-primary"
                disabled={busy || !enabled || !collectionEnabled}
                onClick={() => void execute(() => advance(selected.id))}
              >
                Resume audit
              </button>
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={() =>
                  void execute(async () => {
                    await send("cancel", { auditId: selected.id });
                    setSelected(await read(`${base}&auditId=${selected.id}`));
                    setRuns(await read(base));
                    setMessage(
                      "Audit stopped. Captured evidence remains saved.",
                    );
                  })
                }
              >
                Stop audit
              </button>
            </div>
          )}
          {selected.evaluation && (
            <>
              <p>
                {Math.round(selected.evaluation.coverage * 100)}% applicable
                evidence coverage ·{" "}
                {selected.evaluation.score === null
                  ? "Insufficient evidence for an overall score"
                  : `Readiness ${selected.evaluation.score}/100`}
              </p>
              <div className="pilot-tabs">
                <a
                  className="button button-secondary"
                  href={`${base}&auditId=${selected.id}&format=csv`}
                >
                  Export CSV
                </a>
                {editable && collectionEnabled && enabled && (
                  <button
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() =>
                      void execute(async () => {
                        const run = await send("create", {
                          idempotencyKey: crypto.randomUUID(),
                          manifest: selected.manifest,
                        });
                        await advance(run.id);
                      })
                    }
                  >
                    Rerun the same pages
                  </button>
                )}
              </div>
              <label htmlFor="compare-audit">
                Compare with an earlier audit
              </label>
              <select
                className="audit-input"
                id="compare-audit"
                disabled={busy}
                value=""
                onChange={(event) => {
                  const before = event.target.value;
                  if (before)
                    void execute(async () => {
                      const delta = await read(
                        `${base}&auditId=${selected.id}&before=${encodeURIComponent(before)}`,
                      );
                      setComparison(
                        `${delta.resolved.length} resolved · ${delta.new.length} new · ${delta.persistent.length} persistent · ${delta.unevaluated.length} unevaluated`,
                      );
                    });
                }}
              >
                <option value="">Choose a saved audit</option>
                {runs
                  .filter(
                    (run) =>
                      run.id !== selected.id && run.status === "COMPLETED",
                  )
                  .map((run) => (
                    <option key={run.id} value={run.id}>
                      {new Date(run.createdAt).toLocaleString()}
                    </option>
                  ))}
              </select>
              <p role="status">{comparison}</p>
              {editable && collectionEnabled && enabled && (
                <>
                  <label htmlFor="review-reason">
                    Reason for your next review action
                  </label>
                  <input
                    className="audit-input"
                    id="review-reason"
                    maxLength={512}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </>
              )}
              <ul className="audit-findings">
                {selected.evaluation.rules.map((rule) => (
                  <li key={`${rule.ruleId}:${rule.scopeKey}`}>
                    <strong>
                      {rule.ruleId} · {rule.outcome}
                    </strong>
                    <p className="audit-url">{rule.scopeKey}</p>
                    <p>{rule.reasonCode.replaceAll("_", " ").toLowerCase()}</p>
                    {editable &&
                      collectionEnabled &&
                      enabled &&
                      ["FAIL", "WARNING"].includes(rule.outcome) && (
                        <button
                          className="button button-secondary"
                          disabled={busy || !reason.trim()}
                          onClick={() =>
                            void execute(async () => {
                              await send("review", {
                                auditId: selected.id,
                                ruleId: rule.ruleId,
                                scopeKey: rule.scopeKey,
                                disposition: "REVIEWED",
                                reason,
                              });
                              setSelected(
                                await read(`${base}&auditId=${selected.id}`),
                              );
                              setMessage(
                                "Review recorded. Technical outcomes update when evidence is acquired again.",
                              );
                            })
                          }
                        >
                          Mark reviewed
                        </button>
                      )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {selected.pages.map((page) => (
            <details key={page.requestedUrl}>
              <summary className="audit-url">{page.requestedUrl}</summary>
              <p>{page.provenance.error ?? "Original HTML captured"}</p>
              <p>Captured {page.provenance.acquiredAt}</p>
              <p className="audit-url">
                SHA-256 {page.provenance.sha256 ?? "unavailable"}
              </p>
              <a
                href={`${base}&auditId=${selected.id}&format=source&url=${encodeURIComponent(page.requestedUrl)}`}
              >
                Download retained original source
              </a>
            </details>
          ))}
          <p>
            Business context revision{" "}
            {selected.declarations?.contextRevision ?? "not declared"}
          </p>
          {!!selected.actions?.length && (
            <details>
              <summary>Review history</summary>
              <ul>
                {selected.actions.map((action) => (
                  <li key={action.id}>
                    {action.ruleId} · {action.disposition.toLowerCase()} ·{" "}
                    {action.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </>
  );
}
