"use client";
import { useEffect, useState } from "react";
import { useClientReady } from "./use-client-ready";
type Source = { id: string; label: string; kind: "audit" | "gsc" };
type DraftBody = {
  title: string;
  body: string;
  assumptions: string[];
  citations: Array<{ sourceId: string; note: string }>;
};
type Assistance = {
  method: "EVIDENCE_TEMPLATE_V1";
  evidenceFingerprint: string;
  context: { id: string; revision: number };
  content: DraftBody;
  links: Array<{
    id: string;
    sourceId: string;
    sourceUrl: string;
    url: string;
    anchorText: string;
    recommendation: string;
  }>;
  limitations: string[];
};
type Draft = {
  id: string;
  revision: number;
  kind: string;
  history: Array<{
    revision: number;
    content: DraftBody;
    pin?: { pinnedAt: string } | null;
  }>;
  nextHistoryBefore?: number | null;
  sourceAvailability?: Array<{ sourceId: string; status: string }>;
  evidenceStatus?: "available" | "legacy-lineage-withheld";
  snapshot?: {
    context?: { id?: string; revision?: number } | null;
    internalLinks: Array<{
      sourceUrl?: string;
      url: string;
      anchorText?: string;
      basis: string;
    }>;
  };
};
type Report = {
  id: string;
  title: string;
  createdAt: string;
  evidenceFormat?: string | null;
  formatStatus?: { pdf: string; csv: string };
};
type ReportPreview = Report & {
  sourceAvailability: Array<{ sourceId: string; status: string }>;
  snapshot: {
    reportTemplate?: "founder" | "editor" | "agency";
    reportBranding?: { revision: number; displayName: string };
    context?: { id?: string; revision?: number } | null;
    comparisonUnavailable?: boolean;
    historicalComparisonCounts?: Record<string, number>;
    comparison?: { counts: Record<string, number> };
    sources: Array<{
      sourceId: string;
      data: {
        createdAt?: string;
        importedAt?: string;
        metrics?: { clicks?: number; impressions?: number };
        evaluation?: { score: number | null; coverage: number | null };
      };
    }>;
  };
};
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
  const [assistance, setAssistance] = useState<Assistance | null>(null);
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const clientReady = useClientReady();
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [reports, setReports] = useState<Report[]>([]),
    [sources, setSources] = useState<Source[]>([]);
  const [history, setHistory] = useState<Draft["history"]>([]),
    [historyBefore, setHistoryBefore] = useState<number | null>(null);
  const [selected, setSelected] = useState<Draft | null>(null),
    [chosen, setChosen] = useState<string[]>([]),
    [notes, setNotes] = useState<Record<string, string>>({});
  const [reportChosen, setReportChosen] = useState<string[]>([]),
    [reportTitle, setReportTitle] = useState(""),
    [kind, setKind] = useState<"brief" | "draft">("draft");
  const [brandingSelection, setBrandingSelection] = useState({
    scope: "",
    revision: "",
  });
  const [brandingChoices, setBrandingChoices] = useState<{
    scope: string;
    choices: Array<{ revision: number; displayName: string }>;
    state: "ready" | "unavailable";
  }>({ scope: "", choices: [], state: "ready" });
  const [brandingRefresh, setBrandingRefresh] = useState(0);
  const [reportTemplate, setReportTemplate] = useState<
    "founder" | "editor" | "agency"
  >("founder");
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
  const brandingRevision =
    brandingSelection.scope === query ? brandingSelection.revision : "";
  const currentBrandingChoices =
    brandingChoices.scope === query ? brandingChoices.choices : [];
  const brandingState =
    brandingChoices.scope === query ? brandingChoices.state : "loading";
  const brandingValid =
    !brandingRevision ||
    currentBrandingChoices.some(
      (choice) => String(choice.revision) === brandingRevision,
    );
  useEffect(() => {
    if (!editable) return;
    let active = true;
    fetch(`/api/reports?${query}&brandingOptions=1`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (
          !Array.isArray(data.choices) ||
          data.choices.length > 20 ||
          data.choices.some(
            (choice: { revision?: unknown; displayName?: unknown }) =>
              !Number.isSafeInteger(choice?.revision) ||
              Number(choice.revision) < 1 ||
              typeof choice.displayName !== "string" ||
              choice.displayName.length > 100,
          )
        )
          throw new Error();
        if (active)
          setBrandingChoices({
            scope: query,
            choices: data.choices,
            state: "ready",
          });
      })
      .catch(() => {
        if (active)
          setBrandingChoices({
            scope: query,
            choices: [],
            state: "unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [editable, query, brandingRefresh]);
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
    setAssistance(null);
    setSelected(draft);
    setHistory(draft.history);
    setHistoryBefore(draft.nextHistoryBefore ?? null);
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
    : assistance
      ? assistance.content.citations.map((citation) => ({
          ...citation,
          note: notes[citation.sourceId] ?? citation.note,
        }))
      : sources
          .filter((source) => chosen.includes(source.id))
          .map((source) => ({
            sourceId: `${source.kind}:${source.id}`,
            note: notes[`${source.kind}:${source.id}`] ?? "",
          }));
  const hasUnsavedEditorialInput = Boolean(
    title ||
    body ||
    assumptions ||
    Object.values(notes).some((note) => note.length > 0),
  );
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
          Prepare a free evidence-backed writing template or save your own brief
          alongside reviewed evidence. Templates use saved facts and
          assumptions; paid AI generation and live research require a qualified
          provider and cost quote.
        </p>
        {editable && collectionEnabled && (
          <>
            {!clientReady && (
              <p role="status">Preparing draft and report controls…</p>
            )}
            {!selected && (
              <fieldset disabled={!clientReady || busy || !!assistance}>
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
                      ...(assistance
                        ? {
                            expectedContextRevisionId: assistance.context.id,
                            expectedEvidenceFingerprint:
                              assistance.evidenceFingerprint,
                          }
                        : {}),
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
                    disabled={!clientReady || busy || !!assistance}
                    onChange={(event) =>
                      setKind(event.target.value as "brief" | "draft")
                    }
                  >
                    <option value="draft">Page draft</option>
                    <option value="brief">Editorial brief</option>
                  </select>
                </label>
              )}
              {!selected && (
                <div className="pilot-card">
                  <h3>Writing assistance</h3>
                  <p id="template-empty-editor-help">
                    Deterministic template only. No provider request, live
                    research or charge. Review site business context first.
                    Start with an empty title, draft, assumptions, and citation
                    notes to prepare a template. Your entered supporting text is
                    kept.
                  </p>
                  <button
                    type="button"
                    className="button button-secondary"
                    aria-describedby="template-empty-editor-help"
                    disabled={
                      !clientReady ||
                      busy ||
                      !chosen.length ||
                      hasUnsavedEditorialInput ||
                      !!assistance
                    }
                    onClick={() =>
                      void perform(async () => {
                        const prepared: Assistance = await request(
                          "/api/content",
                          { action: "assist", kind, ...selectionFor(chosen) },
                        );
                        setAssistance(prepared);
                        setTitle(prepared.content.title);
                        setBody(prepared.content.body);
                        setAssumptions(prepared.content.assumptions.join("\n"));
                        setNotes(
                          Object.fromEntries(
                            prepared.content.citations.map((c) => [
                              c.sourceId,
                              c.note,
                            ]),
                          ),
                        );
                        setMessage(
                          "Template prepared for review. Edit or discard it; nothing is saved until you choose Save draft with evidence.",
                        );
                      })
                    }
                  >
                    Prepare evidence template
                  </button>
                  {assistance && (
                    <>
                      <p>
                        Reviewed context revision {assistance.context.revision}
                      </p>
                      <p>
                        Method: {assistance.method}. Context:{" "}
                        {assistance.context.id}
                      </p>
                      <ul>
                        {assistance.limitations.map((limit) => (
                          <li key={limit}>{limit}</li>
                        ))}
                      </ul>
                      <h4>Internal-link review suggestions</h4>
                      {!assistance.links.length && (
                        <p>
                          No eligible observed anchors between acquired pages
                          were available. No links were invented.
                        </p>
                      )}
                      <ul className="audit-history">
                        {assistance.links.map((link) => (
                          <li key={link.id}>
                            <p>{link.anchorText}</p>
                            <p className="audit-url">
                              Source: {link.sourceUrl}
                            </p>
                            <p className="audit-url">Destination: {link.url}</p>
                            <p>
                              {link.recommendation} Evidence: {link.sourceId}
                            </p>
                            <button
                              type="button"
                              className="button button-secondary"
                              disabled={busy}
                              onClick={() => {
                                setBody(
                                  (current) =>
                                    current +
                                    `\n\nInternal-link review [${link.sourceId}]: on ${link.sourceUrl}, review the existing link to ${link.url} with observed anchor ${JSON.stringify(link.anchorText)}. Verify rendered visibility and relevance before editing.`,
                                );
                                setAssistance({
                                  ...assistance,
                                  links: assistance.links.filter(
                                    (item) => item.id !== link.id,
                                  ),
                                });
                                setMessage(
                                  "Link review added to your editable draft. It has not been saved.",
                                );
                              }}
                            >
                              Use link suggestion
                            </button>{" "}
                            <button
                              type="button"
                              className="button button-secondary"
                              disabled={busy}
                              onClick={() => {
                                setAssistance({
                                  ...assistance,
                                  links: assistance.links.filter(
                                    (item) => item.id !== link.id,
                                  ),
                                });
                                setMessage(
                                  "Link suggestion rejected. No saved content changed.",
                                );
                              }}
                            >
                              Reject link suggestion
                            </button>
                          </li>
                        ))}
                      </ul>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy}
                        onClick={() => {
                          setAssistance(null);
                          setTitle("");
                          setBody("");
                          setAssumptions("");
                          setNotes({});
                          setMessage(
                            "Prepared template discarded. No draft was saved.",
                          );
                        }}
                      >
                        Discard prepared template
                      </button>
                    </>
                  )}
                </div>
              )}
              <label htmlFor="draft-title">Draft title</label>
              <input
                className="audit-input"
                id="draft-title"
                maxLength={200}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                disabled={!clientReady || busy}
              />
              <label htmlFor="draft-body">Editable Markdown draft</label>
              <textarea
                className="audit-input"
                id="draft-body"
                rows={14}
                maxLength={100000}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                disabled={!clientReady || busy}
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
                disabled={!clientReady || busy}
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
                    disabled={!clientReady || busy}
                  />
                </div>
              ))}
              <div className="pilot-tabs">
                <button
                  className="button button-primary"
                  disabled={
                    !clientReady || busy || (!selected && !chosen.length)
                  }
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
                    disabled={!clientReady || busy}
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
            {selected.evidenceStatus === "legacy-lineage-withheld" && (
              <p>
                Historical source evidence is withheld because its source
                lineage could not be verified. Your authored draft, citations
                and revision history remain available.
              </p>
            )}
            {selected.snapshot && (
              <p>
                Captured site context revision{" "}
                {selected.snapshot.context?.revision ?? "unavailable"} ·{" "}
                {selected.snapshot.context?.id ?? "unknown"}
              </p>
            )}
            {(!editable || !collectionEnabled) && (
              <pre className="audit-url">
                {selected.history[0]?.content.body}
              </pre>
            )}
            {selected.sourceAvailability?.map((source) => (
              <p key={source.sourceId} className="audit-url">
                {source.sourceId} · source {source.status}
              </p>
            ))}
            {selected.history[0]?.content.citations.map((c, i) => (
              <p key={i} className="audit-url">
                Saved citation · {c.note}
              </p>
            ))}
            <details>
              <summary>Saved revision history</summary>
              <p>
                The current revision and pinned revisions stay available. Other
                revisions are available for 90 days.
              </p>
              <ul>
                {history.map((revision) => (
                  <li key={revision.revision}>
                    <strong>
                      Revision {revision.revision} · {revision.content.title}
                    </strong>
                    <pre className="audit-url">{revision.content.body}</pre>
                    {revision.pin && <span>Pinned revision</span>}
                    {editable && collectionEnabled && (
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            const updated = await request("/api/content", {
                              action: "pin",
                              draftId: selected.id,
                              revision: revision.revision,
                              pinned: !revision.pin,
                            });
                            // Pinning changes retention only; preserve the editing base, including its citations.
                            setHistory((current) =>
                              current.flatMap((r) =>
                                r.revision !== revision.revision
                                  ? [r]
                                  : updated.available === false
                                    ? []
                                    : [{ ...r, pin: updated.pin }],
                              ),
                            );
                            setMessage(
                              `Revision ${revision.revision} ${revision.pin ? "unpinned" : "pinned"}.`,
                            );
                          })
                        }
                      >
                        {revision.pin ? "Unpin" : "Pin"} revision{" "}
                        {revision.revision}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {historyBefore !== null && (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const [older] = await request(
                        `/api/content?${query}&draftId=${encodeURIComponent(selected.id)}&beforeRevision=${historyBefore}`,
                      );
                      setHistory((current) => [...current, ...older.history]);
                      setHistoryBefore(older.nextHistoryBefore ?? null);
                    })
                  }
                >
                  Load older revisions
                </button>
              )}
            </details>
            <details>
              <summary>Observed internal-link evidence</summary>
              {selected.evidenceStatus === "legacy-lineage-withheld" ? (
                <p>
                  Historical internal-link evidence is withheld pending
                  source-lineage verification.
                </p>
              ) : !selected.snapshot ? (
                <p>Saved internal-link evidence is unavailable.</p>
              ) : selected.snapshot.internalLinks.length ? (
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
              disabled={!clientReady || busy}
              onChange={(event) => setReportTitle(event.target.value)}
            />
            <label htmlFor="report-template">Report template</label>
            <select
              id="report-template"
              className="audit-input"
              value={reportTemplate}
              disabled={!clientReady || busy}
              onChange={(event) =>
                setReportTemplate(
                  event.target.value as "founder" | "editor" | "agency",
                )
              }
            >
              <option value="founder">Founder decision brief</option>
              <option value="editor">Editor action worksheet</option>
              <option value="agency">Agency client delivery</option>
            </select>
            <label htmlFor="report-branding">Report branding</label>
            <select
              id="report-branding"
              className="audit-input"
              aria-describedby="report-branding-help"
              value={brandingRevision}
              disabled={!clientReady || busy || brandingState === "loading"}
              onChange={(event) =>
                setBrandingSelection({
                  scope: query,
                  revision: event.target.value,
                })
              }
            >
              <option value="">Lyraseo</option>
              {currentBrandingChoices.map((choice) => (
                <option key={choice.revision} value={String(choice.revision)}>
                  {choice.displayName || "Workspace brand"} · version{" "}
                  {choice.revision}
                </option>
              ))}
              {!brandingValid && (
                <option value={brandingRevision} disabled>
                  Previously selected branding unavailable
                </option>
              )}
            </select>
            <p id="report-branding-help" aria-live="polite">
              {brandingState === "loading"
                ? "Loading approved workspace branding. Lyraseo reports remain available."
                : brandingState === "unavailable"
                  ? "Workspace branding could not load. Lyraseo reports remain available."
                  : !currentBrandingChoices.length
                    ? "No approved workspace branding is available. Use Lyraseo branding."
                    : "Choose an approved workspace brand or Lyraseo. The saved report freezes that name and logo; later changes never alter it."}
              {!brandingValid &&
                " Choose available branding before creating this report."}
            </p>
            {brandingState === "unavailable" && (
              <button
                type="button"
                className="button button-secondary"
                disabled={busy || !clientReady}
                onClick={() => setBrandingRefresh((current) => current + 1)}
              >
                Retry branding choices
              </button>
            )}
            <p>
              Templates retain the same source scope, dates, coverage and
              limitations. Reports are private and require current site access.
            </p>
            <fieldset disabled={!clientReady || busy}>
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
            <fieldset
              disabled={!clientReady || busy}
              aria-describedby="report-comparison-help"
            >
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
              disabled={
                !clientReady ||
                busy ||
                !reportChosen.length ||
                !reportTitle.trim() ||
                !brandingValid
              }
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
                    reportTemplate,
                    ...(brandingRevision
                      ? { brandingRevision: Number(brandingRevision) }
                      : {}),
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
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() =>
                  void perform(
                    async () =>
                      setPreview(
                        await request(
                          `/api/reports?${query}&reportId=${encodeURIComponent(report.id)}&format=preview`,
                        ),
                      ),
                    true,
                  )
                }
              >
                Preview {report.title}
              </button>
              {preview?.id === report.id && (
                <section aria-label="Saved report preview">
                  {preview.snapshot.sources.map((source) => (
                    <p key={source.sourceId} className="audit-url">
                      {source.sourceId} · source{" "}
                      {preview.sourceAvailability.find(
                        (s) => s.sourceId === source.sourceId,
                      )?.status ?? "unavailable"}{" "}
                      ·{" "}
                      {source.data.createdAt ??
                        source.data.importedAt ??
                        "Capture date unavailable"}
                      {source.data.metrics && (
                        <>
                          {" "}
                          · Saved clicks{" "}
                          {source.data.metrics.clicks ?? "unavailable"},
                          impressions{" "}
                          {source.data.metrics.impressions ?? "unavailable"}
                        </>
                      )}
                      {source.data.evaluation && (
                        <>
                          {" "}
                          · Saved score{" "}
                          {source.data.evaluation.score ?? "unavailable"},
                          coverage{" "}
                          {source.data.evaluation.coverage ?? "unavailable"}
                        </>
                      )}
                    </p>
                  ))}
                  {preview.snapshot.comparison && (
                    <p>
                      {Object.entries(preview.snapshot.comparison.counts)
                        .map(([key, count]) => key + " " + count)
                        .join(" · ")}
                    </p>
                  )}
                  {preview.snapshot.comparisonUnavailable && (
                    <p>
                      Historical classifications unavailable.{" "}
                      {Object.entries(
                        preview.snapshot.historicalComparisonCounts ?? {},
                      )
                        .map(([key, count]) => key + " " + count)
                        .join(" · ")}
                    </p>
                  )}
                </section>
              )}
              <div className="pilot-tabs">
                {(["pdf", "csv"] as const).map((format) =>
                  report.formatStatus?.[format] === "available" ? (
                    <a
                      key={format}
                      className="button button-secondary"
                      href={`/api/reports?${query}&reportId=${report.id}&format=${format}`}
                    >
                      Download {format.toUpperCase()}
                    </a>
                  ) : (
                    <p key={format}>
                      {format.toUpperCase()}:{" "}
                      {report.formatStatus?.[format] ?? "pending-review"}.
                    </p>
                  ),
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
