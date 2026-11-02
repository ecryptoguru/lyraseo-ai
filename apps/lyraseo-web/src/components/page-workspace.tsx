"use client";
import { useEffect, useState } from "react";
type Page = {
  id: string;
  originalUrl: string;
  normalizedUrl: string;
  revision: number;
  assignedTo: string | null;
};
type Detail = {
  page: Page;
  actor: { userId: string; canEdit: boolean };
  historyLimit: number;
  history: Array<{
    id: string;
    revision: number;
    action: string;
    note: string;
    userId: string;
    createdAt: string;
    contentDraftId: string | null;
    contentDraftRevision: number | null;
  }>;
  context: { revision: number } | null;
  audits: Array<{
    id: string;
    status: string;
    createdAt: string;
    methodologyVersion: string;
    pages: Array<{
      requestedUrl: string;
      evidence: unknown;
      provenance: unknown;
    }>;
    findings: Array<{
      ruleId: string;
      outcome: string;
      reasonCode: string;
      evidence?: string;
    }>;
  }>;
  search: {
    source: string;
    opportunities: Array<{
      query: string;
      kind: string;
      explanation: string;
      evidence: unknown;
    }>;
    snapshots: Array<{
      id: string;
      startDate: string;
      endDate: string;
      status: string;
    }>;
  };
  drafts: Array<{
    id: string;
    kind: string;
    revision: number;
    history: Array<{
      revision: number;
      content: { title: string; body: string };
    }>;
  }>;
  reports: Array<{ id: string; title: string; createdAt: string }>;
  ai: { message: string };
};
export function PageWorkspace({
  workspaceId,
  siteId,
  origin,
  editable,
  collectionEnabled = true,
  pageId,
}: {
  collectionEnabled?: boolean;
  workspaceId: string;
  siteId: string;
  origin: string;
  editable: boolean;
  pageId?: string;
}) {
  const [pages, setPages] = useState<Page[]>([]),
    [detail, setDetail] = useState<Detail | null>(null);
  const [url, setUrl] = useState(`${origin}/`),
    [note, setNote] = useState(""),
    [draftId, setDraftId] = useState("");
  const [drafts, setDrafts] = useState<
    Array<{ id: string; history: Array<{ content: { title: string } }> }>
  >([]);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("Loading saved page work…");
  const query = `workspaceId=${encodeURIComponent(workspaceId)}&siteId=${encodeURIComponent(siteId)}`;
  const base = `/app/sites/${encodeURIComponent(siteId)}/pages`;
  async function request(command?: Record<string, unknown>) {
    const response = await fetch(
      `/api/pages${command ? "" : `?${query}${pageId ? `&pageId=${encodeURIComponent(pageId)}` : ""}`}`,
      command
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId, siteId, ...command }),
          }
        : { cache: "no-store" },
    );
    const value = await response.json();
    if (!response.ok)
      throw new Error(value.error ?? "Page work is unavailable.");
    return value;
  }
  useEffect(() => {
    let active = true;
    fetch(
      `/api/pages?${query}${pageId ? `&pageId=${encodeURIComponent(pageId)}` : ""}`,
      { cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            "This page workspace could not load. Check your access and refresh to retry.",
          );
        return response.json();
      })
      .then((value) => {
        if (active) {
          if (pageId) setDetail(value);
          else setPages(value.pages);
          setMessage(
            pageId
              ? "Saved evidence and recorded changes loaded."
              : "Register an exact URL to keep its evidence and changes together.",
          );
        }
      })
      .catch((error) => {
        if (active) setMessage(error.message);
      });
    if (editable && pageId)
      fetch(`/api/content?${query}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : []))
        .then((value) => {
          if (active) setDrafts(value);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [query, pageId, editable]);
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to save. Your note remains in the editor.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function change(action: "change" | "claim" | "unassign") {
    if (!detail) return;
    await request({
      action,
      pageId: detail.page.id,
      expectedRevision: detail.page.revision,
      idempotencyKey: crypto.randomUUID(),
      ...(action === "change"
        ? { note, ...(draftId ? { contentDraftId: draftId } : {}) }
        : {}),
    });
    setDetail(await request());
    if (action === "change") {
      setNote("");
      setDraftId("");
    }
    setMessage(
      action === "change"
        ? "Change recorded. Rerun the saved manifest to check whether the finding resolves."
        : action === "claim"
          ? "Page task assigned to you."
          : "Your page task is unassigned.",
    );
  }
  return (
    <>
      {!collectionEnabled && (
        <p className="notice" role="status">
          This capability is paused. Saved evidence remains readable; safe
          recovery controls remain available.
        </p>
      )}
      <section className="pilot-card" aria-labelledby="page-identity">
        <h2 id="page-identity">{detail ? "Page identity" : "Pages"}</h2>
        <p>
          Regional paths and meaningful URL parameters keep separate histories.
          Recording a change updates workflow; an audit rerun supplies fresh
          evidence.
        </p>
        {!pageId && editable && collectionEnabled && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const page = await request({ action: "register", url });
                setPages((existing) => [
                  page,
                  ...existing.filter((item) => item.id !== page.id),
                ]);
                setMessage(
                  "Page registered. Open its saved workspace from the list below.",
                );
              });
            }}
          >
            <label htmlFor="registered-url">Exact page URL</label>
            <input
              id="registered-url"
              className="audit-input"
              type="url"
              value={url}
              required
              maxLength={2048}
              onChange={(event) => setUrl(event.target.value)}
              disabled={busy}
            />
            <button className="button button-primary" disabled={busy}>
              Register page
            </button>
          </form>
        )}
        {!pageId && !pages.length && (
          <p>
            No registered pages yet. An editor can register a page on this site.
          </p>
        )}
        {!pageId && (
          <ul className="audit-history">
            {pages.map((page) => (
              <li key={page.id}>
                <a
                  className="audit-url"
                  href={`${base}/${encodeURIComponent(page.id)}?workspaceId=${encodeURIComponent(workspaceId)}`}
                >
                  {page.normalizedUrl}
                </a>
                <p>
                  Revision {page.revision} ·{" "}
                  {page.assignedTo ? "Assigned" : "Unassigned"}
                </p>
              </li>
            ))}
          </ul>
        )}
        {detail && (
          <>
            <p className="audit-url">{detail.page.normalizedUrl}</p>
            <p>
              Originally registered:{" "}
              <span className="audit-url">{detail.page.originalUrl}</span>
            </p>
            <p>
              Workflow revision {detail.page.revision} ·{" "}
              {detail.context
                ? `Current reviewed context revision ${detail.context.revision}`
                : "Business context not reviewed yet"}
            </p>
            <p>
              {detail.page.assignedTo === detail.actor.userId
                ? "Assigned to you"
                : detail.page.assignedTo
                  ? "Assigned to another site editor"
                  : "Unassigned"}
            </p>
            {editable && collectionEnabled && detail.actor.canEdit && (
              <div className="pilot-tabs">
                <button
                  className="button button-secondary"
                  disabled={busy || !!detail.page.assignedTo}
                  onClick={() => void perform(() => change("claim"))}
                >
                  Assign to me
                </button>
                <button
                  className="button button-secondary"
                  disabled={
                    busy || detail.page.assignedTo !== detail.actor.userId
                  }
                  onClick={() => void perform(() => change("unassign"))}
                >
                  Unassign my task
                </button>
              </div>
            )}
          </>
        )}
        <p role="status" aria-live="polite">
          {message}
        </p>
      </section>
      {detail && (
        <>
          <section className="pilot-card" aria-labelledby="page-changes">
            <h2 id="page-changes">Recorded changes and drafts</h2>
            {editable && collectionEnabled && detail.actor.canEdit && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform(() => change("change"));
                }}
              >
                <label htmlFor="page-change-note">
                  What changed on this page?
                </label>
                <textarea
                  id="page-change-note"
                  className="audit-input"
                  rows={4}
                  value={note}
                  required
                  maxLength={4000}
                  disabled={busy}
                  onChange={(event) => setNote(event.target.value)}
                />
                <label htmlFor="page-linked-draft">
                  Link a saved draft revision (optional)
                </label>
                <select
                  id="page-linked-draft"
                  className="audit-input"
                  value={draftId}
                  disabled={busy}
                  onChange={(event) => setDraftId(event.target.value)}
                >
                  <option value="">No linked draft</option>
                  {drafts.map((draft) => (
                    <option key={draft.id} value={draft.id}>
                      {draft.history[0]?.content.title ?? "Saved draft"}
                    </option>
                  ))}
                </select>
                <button
                  className="button button-primary"
                  disabled={busy || !note.trim()}
                >
                  Record change
                </button>
              </form>
            )}
            <p>
              Showing up to {detail.historyLimit} recent journal entries. Linked
              drafts retain the revision reviewed when the change was recorded.
            </p>
            {!detail.history.length && <p>No recorded changes yet.</p>}
            <ol className="audit-history">
              {detail.history.map((entry) => (
                <li key={entry.id}>
                  <strong>
                    Revision {entry.revision} · {entry.action}
                  </strong>
                  <p>
                    {new Date(entry.createdAt).toLocaleString()} ·{" "}
                    {entry.userId === detail.actor.userId
                      ? "You"
                      : "Site collaborator"}
                  </p>
                  {entry.note && <p className="audit-url">{entry.note}</p>}
                  {entry.contentDraftId && (
                    <p>Linked draft revision {entry.contentDraftRevision}</p>
                  )}
                </li>
              ))}
            </ol>
            {detail.drafts.map((draft) => (
              <details key={draft.id}>
                <summary>Linked {draft.kind} revisions</summary>
                {draft.history.map((revision) => (
                  <article key={revision.revision}>
                    <h3>
                      {revision.content.title} · revision {revision.revision}
                    </h3>
                    <pre className="audit-url">{revision.content.body}</pre>
                  </article>
                ))}
              </details>
            ))}
          </section>
          <section className="pilot-card" aria-labelledby="page-audits">
            <h2 id="page-audits">Audit evidence for this URL</h2>
            <p>
              Up to five recent manifests containing this exact URL. Open an
              audit to inspect the full scope, compare runs or rerun that
              manifest.
            </p>
            <a
              href={`/app/sites/${encodeURIComponent(siteId)}/audits?workspaceId=${encodeURIComponent(workspaceId)}`}
            >
              Open saved audits and reruns
            </a>
            {!detail.audits.length && (
              <p>No saved audit manifest includes this URL yet.</p>
            )}
            {detail.audits.map((audit) => (
              <article key={audit.id}>
                <h3>
                  {new Date(audit.createdAt).toLocaleString()} · {audit.status}
                </h3>
                <p>
                  Audit {audit.id} · methodology {audit.methodologyVersion}
                </p>
                {!audit.pages.length && (
                  <p>
                    This URL has no completed acquisition in this run. It
                    remains unevaluated.
                  </p>
                )}
                <ul>
                  {audit.findings.map((finding, index) => (
                    <li key={`${finding.ruleId}:${index}`}>
                      <strong>
                        {finding.ruleId} · {finding.outcome}
                      </strong>
                      <p>{finding.reasonCode}</p>
                      {finding.evidence && (
                        <p className="audit-url">{finding.evidence}</p>
                      )}
                    </li>
                  ))}
                </ul>
                <details>
                  <summary>Captured evidence and acquisition receipt</summary>
                  <pre className="audit-url">
                    {JSON.stringify(audit.pages, null, 2)}
                  </pre>
                </details>
              </article>
            ))}
          </section>
          <section className="pilot-card" aria-labelledby="page-search">
            <h2 id="page-search">Observed search opportunities</h2>
            <p>
              {detail.search.source}. Only exact URL matches are attached here.
              Missing rows remain unavailable.
            </p>
            {!detail.search.opportunities.length && (
              <p>No retained opportunity evidence matches this URL.</p>
            )}
            {detail.search.opportunities.map((opportunity, index) => (
              <article key={index}>
                <h3>{opportunity.query || opportunity.kind}</h3>
                <p>{opportunity.explanation}</p>
                <details>
                  <summary>Search window and evidence</summary>
                  <pre className="audit-url">
                    {JSON.stringify(opportunity.evidence, null, 2)}
                  </pre>
                </details>
              </article>
            ))}
            <p>{detail.ai.message}</p>
            <a
              href={`/app/sites/${encodeURIComponent(siteId)}/visibility?workspaceId=${encodeURIComponent(workspaceId)}`}
            >
              Open site AI observations
            </a>
          </section>
          <section className="pilot-card" aria-labelledby="page-reports">
            <h2 id="page-reports">
              Reports containing this page’s audit evidence
            </h2>
            {!detail.reports.length && <p>No matching private report yet.</p>}
            <ul>
              {detail.reports.map((report) => (
                <li key={report.id}>
                  {report.title} ·{" "}
                  <a
                    href={`/api/reports?${query}&reportId=${encodeURIComponent(report.id)}&format=pdf`}
                  >
                    Download PDF
                  </a>
                </li>
              ))}
            </ul>
            <a
              href={`/app/sites/${encodeURIComponent(siteId)}/content?workspaceId=${encodeURIComponent(workspaceId)}`}
            >
              Open content and report workspace
            </a>
          </section>
        </>
      )}
    </>
  );
}
