"use client";
import { useEffect, useRef, useState } from "react";
import {
  auditLines,
  AuditDeclarationsForm,
  readAuditDeclarations,
} from "./audit-declarations";
import type {
  AuditEvaluation,
  ReadinessDeclarations,
  RobotsPolicyObservation,
} from "@lyraseo/visibility";

type Summary = { id: string; status: string; createdAt: string };
type SavedRun = Summary & {
  manifest: string[];
  evaluation: AuditEvaluation | null;
  declarations?: ReadinessDeclarations & { contextRevision?: number };
  methodologyVersion?: string;
  actions?: Array<{
    id: string;
    ruleId: string;
    disposition: string;
    reason: string;
  }>;
  pages: Array<{
    requestedUrl: string;
    provenance: {
      error?: string;
      sha256?: string;
      acquiredAt?: string;
      robotsPolicy?: RobotsPolicyObservation;
    };
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
  const manifestInput = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<{
    revision: number;
    initial?: ReadinessDeclarations;
  }>({ revision: 0 });
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
              const pages = auditLines(manifest);
              const declarations = readAuditDeclarations(
                new FormData(event.currentTarget),
                pages,
              );
              void execute(async () => {
                const run = await send("create", {
                  idempotencyKey: crypto.randomUUID(),
                  manifest: pages,
                  declarations,
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
              ref={manifestInput}
              rows={5}
              value={manifest}
              onChange={(event) => setManifest(event.target.value)}
              disabled={busy}
              required
            />
            <AuditDeclarationsForm
              key={draft.revision}
              initial={draft.initial}
              pages={auditLines(manifest)}
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
                {selected.methodologyVersion ??
                  selected.evaluation.methodologyVersion}{" "}
                · {Math.round(selected.evaluation.coverage * 100)}% applicable
                evidence coverage ·{" "}
                {selected.evaluation.score === null
                  ? "Insufficient evidence for an overall score"
                  : `Readiness ${selected.evaluation.score}/100`}
              </p>
              {selected.evaluation.categoryCoverage && (
                <ul aria-label="Category evidence coverage">
                  {Object.entries(selected.evaluation.categoryCoverage).map(
                    ([category, coverage]) => (
                      <li key={category}>
                        {category}:{" "}
                        {coverage === null
                          ? "Not applicable"
                          : Math.round(coverage * 100) + "% coverage"}
                      </li>
                    ),
                  )}
                </ul>
              )}
              {selected.evaluation.duplicateDestinations?.map((d) => (
                <p className="audit-url" key={d.finalUrl}>
                  {d.requestedUrls.join(", ")} share final destination{" "}
                  {d.finalUrl}.
                </p>
              ))}
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
                    onClick={() => {
                      setManifest(selected.manifest.join("\n"));
                      setDraft(({ revision }) => ({
                        revision: revision + 1,
                        initial: selected.declarations,
                      }));
                      setMessage(
                        "Review the selected pages and declarations, then confirm the new audit.",
                      );
                      manifestInput.current?.focus();
                    }}
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
                        `${delta.resolved.length} resolved · ${delta.new.length} new · ${delta.persistent.length} persistent · ${delta.improved.length} improved but unresolved · ${delta.worsened.length} worsened · ${delta.unevaluated.length} unevaluated · ${delta.scoreDelta === null ? "No comparable score change" : "Score change " + delta.scoreDelta}`,
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
                    {rule.evidence && (
                      <p className="audit-url">{rule.evidence}</p>
                    )}
                    {rule.evidenceRefs && (
                      <details>
                        <summary>
                          Evidence sources (rule version {rule.ruleVersion})
                        </summary>
                        <ul>
                          {rule.evidenceRefs.map((ref, i) => (
                            <li key={i} className="audit-url">
                              {ref.source} {ref.requestedUrl} ·{" "}
                              {ref.fields.join(", ")}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
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
              {page.provenance.robotsPolicy && (
                <RobotsPolicyDetails policy={page.provenance.robotsPolicy} />
              )}
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
          {selected.declarations && (
            <details>
              <summary>Frozen declarations for this audit</summary>
              <dl className="audit-url">
                {(
                  [
                    ["Display brand", selected.declarations.brandName],
                    [
                      "Approved aliases",
                      selected.declarations.approvedAliases?.join(", "),
                    ],
                    [
                      "Official URLs",
                      selected.declarations.officialUrls?.join(", "),
                    ],
                    ["About URL", selected.declarations.aboutUrl],
                    ["Contact URL", selected.declarations.contactUrl],
                    [
                      "Required policies",
                      selected.declarations.requiredPolicyUrls?.join(", "),
                    ],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value || "Undeclared"}</dd>
                  </div>
                ))}
              </dl>
              {selected.declarations.pageDeclarations?.map((d) => (
                <p className="audit-url" key={d.requestedUrl}>
                  {d.requestedUrl} · indexing {d.indexingIntent ?? "undeclared"}{" "}
                  · page type {d.pageType ?? "undeclared"} · expected canonical{" "}
                  {d.intendedCanonical ?? "undeclared"}
                </p>
              ))}
            </details>
          )}
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

function RobotsPolicyDetails({ policy }: { policy: RobotsPolicyObservation }) {
  return (
    <details className="audit-url">
      <summary>Google robots policy evidence</summary>
      <p>
        {policy.state} ·{" "}
        {policy.status === undefined
          ? "HTTP status unavailable"
          : "HTTP " + policy.status}{" "}
        · {policy.acquiredAt}
      </p>
      <p>
        Policy URL {policy.requestedUrl}
        {policy.finalUrl &&
          policy.finalUrl !== policy.requestedUrl &&
          " → " + policy.finalUrl}
      </p>
      <p>Policy SHA-256 {policy.sha256 ?? "Unavailable"}</p>
      {policy.requested && (
        <p>
          Requested {policy.requested.url} ·{" "}
          {policy.requested.allowed === undefined
            ? "unknown"
            : policy.requested.allowed
              ? "allowed"
              : "disallowed"}
        </p>
      )}
      {policy.final && (
        <p>
          Final {policy.final.url} ·{" "}
          {policy.final.allowed === undefined
            ? "unknown"
            : policy.final.allowed
              ? "allowed"
              : "disallowed"}
        </p>
      )}
      {policy.googleGroup && (
        <>
          <p>Applicable group {policy.googleGroup.agent}</p>
          <ul>
            {policy.googleGroup.rules.map((rule, i) => (
              <li key={i}>
                {rule.directive}: {rule.pattern}
              </li>
            ))}
          </ul>
        </>
      )}
      {policy.state === "evidence-limited" && (
        <p>
          The applicable group exceeded the evidence limit. Google access is
          unevaluated.
        </p>
      )}
    </details>
  );
}
