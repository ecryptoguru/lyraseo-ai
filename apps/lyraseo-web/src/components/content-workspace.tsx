"use client";
import { useEffect, useState } from "react";
type Source = { id: string; label: string; kind: "audit" | "gsc" };
type DraftBody = {
  title: string;
  body: string;
  assumptions: string[];
  citations: Array<{ sourceId: string; note: string }>;
};
type Draft = {
  id: string;
  revision: number;
  kind: string;
  history: Array<{ revision: number; content: DraftBody }>;
  snapshot: {
    internalLinks: Array<{
      sourceUrl?: string;
      url: string;
      anchorText?: string;
      basis: string;
    }>;
  };
};
type Report = { id: string; title: string; createdAt: string };
export function ContentWorkspace({
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
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [reports, setReports] = useState<Report[]>([]),
    [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<Draft | null>(null),
    [chosen, setChosen] = useState<string[]>([]),
    [notes, setNotes] = useState<Record<string, string>>({});
  const [reportChosen, setReportChosen] = useState<string[]>([]),
    [reportTitle, setReportTitle] = useState(""),
    [kind, setKind] = useState<"brief" | "draft">("draft");
  const [reportMessage, setReportMessage] = useState("");
  const [comparisonEnabled, setComparisonEnabled] = useState(false),
    [beforeAuditId, setBeforeAuditId] = useState(""),
    [afterAuditId, setAfterAuditId] = useState("");
  const [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [assumptions, setAssumptions] = useState("");
  const [message, setMessage] = useState("Loading saved work…"),
    [busy, setBusy] = useState(false);
  const query = `workspaceId=${encodeURIComponent(workspaceId)}&siteId=${encodeURIComponent(siteId)}`;
  async function request(url: string, command?: Record<string, unknown>) {
    const response = await fetch(
      url,
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
      throw new Error(value.error ?? "Saved work is temporarily unavailable.");
    return value;
  }
  async function refresh() {
    const [saved, exports] = await Promise.all([
      request(`/api/content?${query}`),
      request(`/api/reports?${query}`),
    ]);
    setDrafts(saved);
    setReports(exports);
  }
  useEffect(() => {
    let active = true;
    const json = async (path: string) => {
      const response = await fetch(`${path}?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      return response.json();
    };
    Promise.all([
      json("/api/content"),
      json("/api/reports"),
      json("/api/audits"),
      json("/api/search"),
    ])
      .then(([saved, exports, audits, search]) => {
        if (!active) return;
        setDrafts(saved);
        setReports(exports);
        setSources([
          ...audits
            .filter((audit: { status: string }) => audit.status === "COMPLETED")
            .map((audit: { id: string; createdAt: string }) => ({
              id: audit.id,
              label: `Audit ${new Date(audit.createdAt).toLocaleString()} · ${audit.id}`,
              kind: "audit" as const,
            })),
          ...search.snapshots.map(
            (snapshot: {
              id: string;
              shape: string;
              startDate: string;
              endDate: string;
            }) => ({
              id: snapshot.id,
              label: `Search ${snapshot.startDate}–${snapshot.endDate} · ${snapshot.shape}`,
              kind: "gsc" as const,
            }),
          ),
        ]);
        setMessage(
          "Choose saved evidence, draft your changes and save a reviewed revision.",
        );
      })
      .catch(() => {
        if (active)
          setMessage("Saved work could not load. Refresh the page to retry.");
      });
    return () => {
      active = false;
    };
  }, [query]);
  async function perform(work: () => Promise<void>, forReport = false) {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      (forReport ? setReportMessage : setMessage)(
        error instanceof Error
          ? error.message
          : "Unable to save. Your draft remains in the editor.",
      );
    } finally {
      setBusy(false);
    }
  }
  function load(draft: Draft) {
    const content = draft.history[0]?.content;
    if (!content) return;
    setSelected(draft);
    setTitle(content.title);
    setBody(content.body);
    setAssumptions(content.assumptions.join("\n"));
    setNotes(
      Object.fromEntries(
        content.citations.map((citation) => [citation.sourceId, citation.note]),
      ),
    );
    setMessage(`Saved revision ${draft.revision} loaded.`);
  }
  const selectionFor = (ids: string[]) => ({
    auditIds: sources
      .filter((source) => source.kind === "audit" && ids.includes(source.id))
      .map((source) => source.id),
    searchSnapshotIds: sources
      .filter((source) => source.kind === "gsc" && ids.includes(source.id))
      .map((source) => source.id),
  });
  const citations = selected
    ? (selected.history[0]?.content.citations.map((citation) => ({
        ...citation,
        note: notes[citation.sourceId] ?? citation.note,
      })) ?? [])
    : sources
        .filter((source) => chosen.includes(source.id))
        .map((source) => ({
          sourceId: `${source.kind}:${source.id}`,
          note: notes[`${source.kind}:${source.id}`] ?? "",
        }));
  return (
    <>
      {!collectionEnabled && (
        <p className="notice" role="status">
          This capability is paused. Saved evidence remains readable; safe
          recovery controls remain available.
        </p>
      )}
      <section className="pilot-card" aria-labelledby="draft-editor">
        <h2 id="draft-editor">Evidence and editable draft</h2>
        <p>
          Save your own brief or page draft alongside the evidence you reviewed.
          Automated generation requires a qualified provider and cost quote.
        </p>
        {editable && collectionEnabled && (
          <>
            {!selected && (
              <fieldset disabled={busy}>
                <legend>
                  Select up to five audits and five search imports
                </legend>
                {sources.length ? (
                  sources.map((source) => (
                    <label
                      className="audit-source"
                      key={`${source.kind}:${source.id}`}
                    >
                      <input
                        type="checkbox"
                        checked={chosen.includes(source.id)}
                        onChange={(event) =>
                          setChosen(
                            event.target.checked
                              ? [...chosen, source.id]
                              : chosen.filter((id) => id !== source.id),
                          )
                        }
                      />{" "}
                      {source.label}
                    </label>
                  ))
                ) : (
                  <p>
                    Complete a saved audit or import Search Console evidence
                    first.
                  </p>
                )}
              </fieldset>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async () => {
                  const fields = {
                    title,
                    body,
                    assumptions: assumptions
                      .split(/\r?\n/)
                      .filter((value) => value.trim()),
                    citations,
                  };
                  if (selected) {
                    await request("/api/content", {
                      action: "save",
                      draftId: selected.id,
                      expectedRevision: selected.revision,
                      ...fields,
                    });
                    const saved = await request(
                      `/api/content?${query}&draftId=${selected.id}`,
                    );
                    load(saved[0]);
                  } else {
                    const saved = await request("/api/content", {
                      action: "create",
                      kind,
                      ...selectionFor(chosen),
                      ...fields,
                    });
                    load(saved);
                  }
                  await refresh();
                  setMessage(
                    "Draft revision saved with its reviewed evidence.",
                  );
                });
              }}
            >
              {!selected && (
                <label>
                  Document type
                  <select
                    className="audit-input"
                    value={kind}
                    disabled={busy}
                    onChange={(event) =>
                      setKind(event.target.value as "brief" | "draft")
                    }
                  >
                    <option value="draft">Page draft</option>
                    <option value="brief">Editorial brief</option>
                  </select>
                </label>
              )}
              <label htmlFor="draft-title">Draft title</label>
              <input
                className="audit-input"
                id="draft-title"
                maxLength={200}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                disabled={busy}
              />
              <label htmlFor="draft-body">Editable Markdown draft</label>
              <textarea
                className="audit-input"
                id="draft-body"
                rows={14}
                maxLength={100000}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                disabled={busy}
              />
              <label htmlFor="draft-assumptions">
                Assumptions to verify, one per line
              </label>
              <textarea
                className="audit-input"
                id="draft-assumptions"
                rows={3}
                value={assumptions}
                onChange={(event) => setAssumptions(event.target.value)}
                disabled={busy}
              />
              {citations.map((citation, index) => (
                <div key={citation.sourceId}>
                  <label htmlFor={`citation-${index}`}>
                    Why {citation.sourceId} supports this draft
                  </label>
                  <input
                    className="audit-input"
                    id={`citation-${index}`}
                    maxLength={1000}
                    value={notes[citation.sourceId] ?? citation.note}
                    onChange={(event) =>
                      setNotes({
                        ...notes,
                        [citation.sourceId]: event.target.value,
                      })
                    }
                    required
                    disabled={busy}
                  />
                </div>
              ))}
              <div className="pilot-tabs">
                <button
                  className="button button-primary"
                  disabled={busy || (!selected && !chosen.length)}
                >
                  {busy
                    ? "Saving…"
                    : selected
                      ? "Save next revision"
                      : "Save draft with evidence"}
                </button>
                {selected && (
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setSelected(null);
                      setTitle("");
                      setBody("");
                      setNotes({});
                      setAssumptions("");
                      setMessage(
                        "New draft started. Previously saved revisions remain available.",
                      );
                    }}
                  >
                    Start another draft
                  </button>
                )}
              </div>
            </form>
          </>
        )}
        <p role="status" aria-live="polite">
          {message}
        </p>
      </section>
      <section className="pilot-card" aria-labelledby="saved-drafts">
        <h2 id="saved-drafts">Saved revisions</h2>
        {!drafts.length && <p>Your first saved draft will appear here.</p>}
        <ul className="audit-history">
          {drafts.map((draft) => (
            <li key={draft.id}>
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const saved = await request(
                      `/api/content?${query}&draftId=${encodeURIComponent(draft.id)}`,
                    );
                    if (!saved[0])
                      throw new Error(
                        "This saved draft is no longer available.",
                      );
                    load(saved[0]);
                  })
                }
              >
                {draft.history[0]?.content.title ?? "Draft"} · revision{" "}
                {draft.revision}
              </button>
            </li>
          ))}
        </ul>
        {selected && (
          <>
            <p>Revision {selected.revision}</p>
            {(!editable || !collectionEnabled) && (
              <pre className="audit-url">
                {selected.history[0]?.content.body}
              </pre>
            )}
            <details>
              <summary>Saved revision history</summary>
              <ul>
                {selected.history.map((revision) => (
                  <li key={revision.revision}>
                    <strong>
                      Revision {revision.revision} · {revision.content.title}
                    </strong>
                    <pre className="audit-url">{revision.content.body}</pre>
                  </li>
                ))}
              </ul>
            </details>
            <details>
              <summary>Observed internal-link evidence</summary>
              {selected.snapshot.internalLinks.length ? (
                <ul>
                  {selected.snapshot.internalLinks.map((link, index) => (
                    <li key={index}>
                      <p className="audit-url">
                        {link.sourceUrl} → {link.url}
                      </p>
                      <p>
                        {link.anchorText} · {link.basis}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  No qualifying anchor context was captured in these selected
                  sources.
                </p>
              )}
            </details>
          </>
        )}
      </section>
      <section className="pilot-card" aria-labelledby="private-reports">
        <h2 id="private-reports">Private evidence reports</h2>
        <p>
          Reports freeze the selected sources, methodology, coverage and
          reviewed context. Downloads require current site access.
        </p>
        {editable && collectionEnabled && (
          <>
            <label htmlFor="report-title">Report title</label>
            <input
              id="report-title"
              className="audit-input"
              value={reportTitle}
              maxLength={200}
              disabled={busy}
              onChange={(event) => setReportTitle(event.target.value)}
            />
            <fieldset disabled={busy}>
              <legend>
                Report evidence: select up to five audits and five search
                imports
              </legend>
              {sources.length ? (
                sources.map((source) => (
                  <label
                    className="audit-source"
                    key={`${source.kind}:${source.id}`}
                  >
                    <input
                      type="checkbox"
                      checked={reportChosen.includes(source.id)}
                      onChange={(event) =>
                        setReportChosen(
                          event.target.checked
                            ? [...reportChosen, source.id]
                            : reportChosen.filter((id) => id !== source.id),
                        )
                      }
                    />{" "}
                    {source.label}
                  </label>
                ))
              ) : (
                <p>No saved evidence is available yet.</p>
              )}
            </fieldset>
            <fieldset disabled={busy} aria-describedby="report-comparison-help">
              <legend>Optional audit comparison</legend>
              <p id="report-comparison-help">
                Choose two distinct completed audits from the report evidence
                above. Explicitly choose their direction: before must be no
                newer than after. Missing or incompatible evidence remains
                unevaluated and cannot prove a fix.
              </p>
              <label className="audit-source">
                <input
                  type="checkbox"
                  checked={comparisonEnabled}
                  onChange={(event) =>
                    setComparisonEnabled(event.target.checked)
                  }
                />{" "}
                Include a frozen before/after comparison
              </label>
              {comparisonEnabled && (
                <>
                  <label htmlFor="report-before">Before audit</label>
                  <select
                    id="report-before"
                    className="audit-input"
                    value={beforeAuditId}
                    onChange={(event) => setBeforeAuditId(event.target.value)}
                  >
                    <option value="">Choose before audit</option>
                    {sources
                      .filter(
                        (source) =>
                          source.kind === "audit" &&
                          (reportChosen.includes(source.id) ||
                            source.id === beforeAuditId),
                      )
                      .map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.label}
                        </option>
                      ))}
                  </select>
                  <label htmlFor="report-after">After audit</label>
                  <select
                    id="report-after"
                    className="audit-input"
                    value={afterAuditId}
                    onChange={(event) => setAfterAuditId(event.target.value)}
                  >
                    <option value="">Choose after audit</option>
                    {sources
                      .filter(
                        (source) =>
                          source.kind === "audit" &&
                          (reportChosen.includes(source.id) ||
                            source.id === afterAuditId),
                      )
                      .map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.label}
                        </option>
                      ))}
                  </select>
                </>
              )}
            </fieldset>
            <button
              className="button button-primary"
              disabled={busy || !reportChosen.length || !reportTitle.trim()}
              onClick={() =>
                void perform(async () => {
                  setReportMessage("");
                  if (
                    comparisonEnabled &&
                    (!beforeAuditId ||
                      !afterAuditId ||
                      beforeAuditId === afterAuditId ||
                      !reportChosen.includes(beforeAuditId) ||
                      !reportChosen.includes(afterAuditId))
                  ) {
                    throw new Error(
                      "Choose two distinct before and after audits included in the report evidence. Your selections have been preserved.",
                    );
                  }
                  await request("/api/reports", {
                    title: reportTitle,
                    ...(comparisonEnabled
                      ? { comparison: { beforeAuditId, afterAuditId } }
                      : {}),
                    ...selectionFor(reportChosen),
                  });
                  await refresh();
                  setReportMessage(
                    "Private report saved. PDF and CSV downloads are ready.",
                  );
                }, true)
              }
            >
              Create report from selected evidence
            </button>
          </>
        )}
        {reportMessage && (
          <p role="status" aria-live="polite">
            {reportMessage}
          </p>
        )}
        {!reports.length && <p>No saved reports yet.</p>}
        <ul className="audit-history">
          {reports.map((report) => (
            <li key={report.id}>
              <h3>{report.title}</h3>
              <p>{new Date(report.createdAt).toLocaleString()}</p>
              <div className="pilot-tabs">
                <a
                  className="button button-secondary"
                  href={`/api/reports?${query}&reportId=${report.id}&format=pdf`}
                >
                  Download PDF
                </a>
                <a
                  className="button button-secondary"
                  href={`/api/reports?${query}&reportId=${report.id}&format=csv`}
                >
                  Download CSV
                </a>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
