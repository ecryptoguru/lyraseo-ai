"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  ChevronRight,
  Check,
  CheckCircle2,
  CircleAlert,
  Copy,
  Download,
  FileText,
  Globe2,
  House,
  Layers3,
  Link2,
  Menu,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  X,
  ChartNoAxesCombined,
  ScanLine,
  RefreshCw,
  Info,
} from "lucide-react";
import {
  sampleAudit,
  sampleEvidence,
  findingCopy,
  auditCsv,
} from "@/lib/sample";
import type { RuleResult } from "@lyraseo/visibility";
const navigation = [
  { key: "overview", label: "Overview", icon: House },
  { key: "sites", label: "Sites", icon: Globe2 },
  { key: "audits", label: "Audits", icon: ScanLine },
  { key: "issues", label: "Issues", icon: Layers3 },
  { key: "content", label: "Content", icon: FileText },
  { key: "visibility", label: "AI visibility", icon: Sparkles },
  { key: "search", label: "Search performance", icon: ChartNoAxesCombined },
  { key: "reports", label: "Reports", icon: Download },
];
const titles: Record<string, [string, string]> = {
  overview: [
    "Your next move, made clear.",
    "A considered view of your website and the work ahead.",
  ],
  sites: ["Your sites", "One place for each website and its evidence."],
  audits: [
    "Review your audit",
    "Inspect the evidence. Decide what to fix next.",
  ],
  issues: [
    "Issues worth a closer look",
    "Review findings without losing the context behind them.",
  ],
  content: [
    "Better content starts with context.",
    "Keep your source evidence close and your editorial decisions yours.",
  ],
  visibility: [
    "See where your brand shows up.",
    "API responses and consumer observations, measured separately.",
  ],
  search: [
    "Search performance",
    "Understand how people find your site through Google Search.",
  ],
  reports: [
    "Evidence, ready to share.",
    "Export retained results without acquiring your website again.",
  ],
  settings: [
    "Workspace settings",
    "Connections, preferences and the boundaries of your private pilot.",
  ],
};
function download(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Workspace({
  view,
  initialTheme = "system",
}: {
  view: string;
  initialTheme?: string;
}) {
  const [menu, setMenu] = useState(false),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [selected, setSelected] = useState("E02"),
    [tab, setTab] = useState("Evidence"),
    [reviewed, setReviewed] = useState<string[]>([]),
    [fixed, setFixed] = useState(false),
    [pendingFix, setPendingFix] = useState(false),
    [running, setRunning] = useState(false),
    [notice, setNotice] = useState(""),
    [dialog, setDialog] = useState(false),
    [theme, setTheme] = useState(initialTheme),
    [detail, setDetail] = useState(false),
    [draft, setDraft] = useState(
      "Example brings project plans, team updates and shared decisions into one clear workspace.",
    ),
    [surface, setSurface] = useState("Azure API");
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const audit = sampleAudit(fixed);
  const issues = audit.rules.filter(
    (r) => r.outcome === "FAIL" || r.outcome === "WARNING",
  );
  const filtered = issues.filter(
    (r) =>
      (filter === "all" ||
        (filter === "reviewed") === reviewed.includes(key(r))) &&
      `${copy(r).title} ${r.scopeKey}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const active = issues.find((r) => key(r) === selected) ?? issues[0];
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () =>
      (document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme);
    update();
    media.addEventListener("change", update);
    document.cookie = `lyraseo-theme=${theme}; path=/; max-age=31536000; SameSite=Lax`;
    return () => media.removeEventListener("change", update);
  }, [theme]);
  useEffect(() => {
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      dialogTrigger.current?.focus();
    };
  }, [dialog]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!menu) return;
    const opener = menuButton.current;
    drawer.current
      ?.querySelector<HTMLButtonElement>('[aria-label="Close navigation"]')
      ?.focus();
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
      if (e.key === "Tab") {
        const nodes = drawer.current?.querySelectorAll<HTMLElement>(
          "a[href],button,select",
        );
        const first = nodes?.[0],
          last = nodes?.[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      opener?.focus();
    };
  }, [menu]);
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => {
      setFixed(pendingFix);
      setRunning(false);
      setDialog(false);
      setNotice(
        pendingFix
          ? "Sample rerun complete. The title issue is resolved."
          : "Sample rerun complete. The unchanged evidence produces the same findings.",
      );
    }, 650);
    return () => clearTimeout(timer);
  }, [running, pendingFix]);
  function key(r: RuleResult) {
    return `${r.ruleId}:${r.scopeKey}`;
  }
  function copy(r: RuleResult) {
    return (
      findingCopy[r.reasonCode] ?? {
        title: r.reasonCode.toLowerCase().replaceAll("_", " "),
        description: "Review the evidence for this observed result.",
        source: r.evidence ?? r.reasonCode,
        guidance:
          "Inspect the observed evidence and confirm the intended behavior before making a change.",
      }
    );
  }
  async function clipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied to clipboard.");
    } catch {
      setNotice(
        "Clipboard access is unavailable. Select and copy the visible text.",
      );
    }
  }
  const [heading, subtitle] = titles[view] ?? titles.overview!;
  return (
    <div className="workspace">
      <aside
        className={`sidebar ${menu ? "sidebar-open" : ""}`}
        ref={drawer}
        inert={dialog}
        aria-label="Workspace navigation"
      >
        <Link href="/" className="app-logo">
          <img
            className="logo-on-light"
            src="/brand/logo-light.svg"
            alt="LyraSEO AI"
            width="185"
            height="36"
          />
          <img
            className="logo-on-dark"
            src="/brand/logo-dark.svg"
            alt="LyraSEO AI"
            width="185"
            height="36"
          />
        </Link>
        <button
          className="mobile-close icon-button"
          onClick={() => setMenu(false)}
          aria-label="Close navigation"
        >
          <X size={20} />
        </button>
        <div className="workspace-identity">
          <span className="avatar square">E</span>
          <div>
            <strong>Example workspace</strong>
            <small>Local sample</small>
          </div>
        </div>
        <div className="site-context">
          <Globe2 size={17} />
          <span>example.com</span>
          <span className="sample-dot" />
        </div>
        <nav aria-label="Workspace">
          <div className="nav-section-label">WORKSPACE</div>
          {navigation.map(({ key: k, label, icon: Icon }) => (
            <Link
              key={k}
              href={`/app/${k}`}
              aria-current={view === k ? "page" : undefined}
              className={view === k ? "active" : ""}
              onClick={() => {
                setMenu(false);
                setDetail(false);
              }}
            >
              <Icon size={19} />
              <span>{label}</span>
              {k === "issues" && (
                <span className="nav-count">{issues.length}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="pilot-note">
            <ShieldCheck size={17} />
            <div>
              <strong>Private pilot</strong>
              <p>
                Synthetic evidence.
                <br />
                No provider spend.
              </p>
            </div>
          </div>
          <Link
            href="/app/settings"
            onClick={() => setMenu(false)}
            aria-current={view === "settings" ? "page" : undefined}
            className={`settings-link ${view === "settings" ? "active" : ""}`}
          >
            <Settings2 size={18} /> Settings
          </Link>
          <div className="theme-control">
            <Sun size={16} />
            <label className="sr-only" htmlFor="theme">
              Color theme
            </label>
            <select
              id="theme"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
            >
              <option value="system">System theme</option>
              <option value="light">Light theme</option>
              <option value="dark">Dark theme</option>
            </select>
          </div>
        </div>
      </aside>
      {menu && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <div className="workspace-main" inert={menu || dialog}>
        <header className="app-topbar">
          <button
            ref={menuButton}
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMenu(true)}
          >
            <Menu size={21} />
          </button>
          <div className="breadcrumb">
            <Globe2 size={17} />
            <span>example.com</span>
            <span className="slash">/</span>
            <span>
              {navigation.find((n) => n.key === view)?.label ?? "Settings"}
            </span>
          </div>
          <div className="topbar-right">
            <span className="pill neutral">Local sample</span>
            <Link
              href="/app/settings"
              className="avatar"
              aria-label="Workspace settings"
            >
              E
            </Link>
          </div>
        </header>
        <main id="main" className="app-content">
          <div className="page-heading">
            <div>
              <h1>{heading}</h1>
              <p>{subtitle}</p>
            </div>
            {["overview", "audits", "issues", "sites"].includes(view) && (
              <button
                className="button button-primary"
                onClick={(e) => {
                  dialogTrigger.current = e.currentTarget;
                  setDialog(true);
                }}
              >
                <RefreshCw size={16} /> Rerun sample audit
              </button>
            )}
            {view === "reports" && (
              <button
                className="button button-primary"
                onClick={() =>
                  download(
                    auditCsv(fixed),
                    "lyraseo-sample-audit.csv",
                    "text/csv;charset=utf-8",
                  )
                }
              >
                <Download size={17} /> Export CSV
              </button>
            )}
          </div>
          <div className="sample-notice">
            <Info size={16} />
            <span>
              This workspace uses synthetic evidence for example.com. Live
              websites, authentication and paid providers are not connected.
            </span>
          </div>
          {["audits", "issues"].includes(view) && (
            <>
              <div className="audit-summary">
                <span className="success-icon">
                  <Check size={18} />
                </span>
                <strong>3 pages checked</strong>
                <span className="summary-dot">·</span>
                <span>Completed</span>
                <span className="summary-dot">·</span>
                <span>23 Oct 2026 · Sample snapshot</span>
                <button
                  className="text-button"
                  onClick={() =>
                    setNotice(
                      `readiness-v1 · ${Math.round(audit.coverage * 100)}% evidence coverage · 3 selected pages · synthetic input`,
                    )
                  }
                >
                  Audit details <ChevronRight size={16} />
                </button>
              </div>
              <div className={`audit-workbench ${detail ? "show-detail" : ""}`}>
                <section className="finding-list" aria-label="Audit findings">
                  <div className="finding-toolbar">
                    <h2>
                      Findings <span>{issues.length}</span>
                    </h2>
                    <label className="sr-only" htmlFor="status-filter">
                      Filter review status
                    </label>
                    <select
                      id="status-filter"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    >
                      <option value="all">All findings</option>
                      <option value="unreviewed">Needs review</option>
                      <option value="reviewed">Reviewed</option>
                    </select>
                  </div>
                  <label className="search-field">
                    <Search size={17} />
                    <input
                      placeholder="Search findings…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      aria-label="Search findings"
                    />
                    {query && (
                      <button
                        onClick={() => setQuery("")}
                        aria-label="Clear search"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </label>
                  <div className="finding-items">
                    {filtered.length ? (
                      filtered.map((r) => (
                        <button
                          key={key(r)}
                          className={`finding-item ${active && key(active) === key(r) ? "selected" : ""}`}
                          onClick={() => {
                            setSelected(key(r));
                            setDetail(true);
                            setTab("Evidence");
                          }}
                        >
                          <span
                            className={`finding-marker ${r.outcome === "FAIL" ? "danger-marker" : "warning-marker"}`}
                          >
                            <CircleAlert size={20} />
                          </span>
                          <span>
                            <strong>{copy(r).title}</strong>
                            <p>{copy(r).description}</p>
                            <small>
                              {new URL(r.scopeKey).pathname}{" "}
                              {reviewed.includes(key(r)) && (
                                <span>· Reviewed</span>
                              )}
                            </small>
                          </span>
                          <ChevronRight size={17} />
                        </button>
                      ))
                    ) : (
                      <div className="empty-state compact">
                        <Search size={23} />
                        <h3>No matching findings</h3>
                        <p>Try another search or review filter.</p>
                        <button
                          className="text-button"
                          onClick={() => {
                            setQuery("");
                            setFilter("all");
                          }}
                        >
                          Clear filters
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="list-footer">
                    <ShieldCheck size={15} /> Measured readiness, not a ranking
                    prediction
                  </div>
                </section>
                <section className="finding-detail" aria-label="Finding detail">
                  <button
                    className="text-button mobile-back"
                    onClick={() => setDetail(false)}
                  >
                    ← All findings
                  </button>
                  {active ? (
                    <>
                      <div className="detail-status">
                        <span className="pill neutral">
                          {reviewed.includes(key(active))
                            ? "Reviewed"
                            : "Needs review"}
                        </span>
                        <span
                          className={`pill ${active.outcome === "FAIL" ? "danger" : "warning"}`}
                        >
                          {active.priority} priority
                        </span>
                        <span className="rule-id">{active.ruleId}</span>
                      </div>
                      <h2>{copy(active).title}</h2>
                      <p className="detail-description">
                        {copy(active).description}
                      </p>
                      <div className="detail-location">
                        <Link2 size={16} />
                        <span>{new URL(active.scopeKey).pathname}</span>
                        <button
                          className="icon-button"
                          aria-label="Copy page URL"
                          onClick={() => clipboard(active.scopeKey)}
                        >
                          <Copy size={14} />
                        </button>
                      </div>
                      <p className="timestamp">
                        Synthetic evidence · 23 Oct 2026
                      </p>
                      <div
                        role="tablist"
                        aria-label="Finding information"
                        className="tabs"
                      >
                        {["Evidence", "Guidance", "History"].map((t) => (
                          <button
                            key={t}
                            role="tab"
                            id={`tab-${t}`}
                            aria-controls="finding-panel"
                            aria-selected={tab === t}
                            onClick={() => setTab(t)}
                            onKeyDown={(e) => {
                              if (
                                e.key === "ArrowRight" ||
                                e.key === "ArrowLeft"
                              ) {
                                const tabs = [
                                  "Evidence",
                                  "Guidance",
                                  "History",
                                ];
                                const idx =
                                  (tabs.indexOf(tab) +
                                    (e.key === "ArrowRight" ? 1 : 2)) %
                                  3;
                                setTab(tabs[idx]!);
                                document
                                  .getElementById(`tab-${tabs[idx]}`)
                                  ?.focus();
                              }
                            }}
                            tabIndex={tab === t ? 0 : -1}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                      <div
                        role="tabpanel"
                        id="finding-panel"
                        aria-labelledby={`tab-${tab}`}
                        tabIndex={0}
                      >
                        {tab === "Evidence" ? (
                          <>
                            <div className="evidence-heading">
                              <strong>Observed source</strong>
                              <span className="pill neutral">Sample</span>
                            </div>
                            <div className="source-block">
                              <code>{copy(active).source}</code>
                              <button
                                className="icon-button"
                                onClick={() => clipboard(copy(active).source)}
                                aria-label="Copy source evidence"
                              >
                                <Copy size={16} />
                              </button>
                            </div>
                            <p className="muted small">
                              {active.reasonCode === "EMPTY_TITLE"
                                ? "The title element is present but empty."
                                : "This observation comes from the selected sample snapshot."}
                            </p>
                          </>
                        ) : tab === "Guidance" ? (
                          <div className="guidance-text">
                            <h3>What to check</h3>
                            <p>{copy(active).guidance}</p>
                            <p>
                              Review the intended behavior before changing your
                              website. A successful rerun is required to
                              establish a technical resolution.
                            </p>
                          </div>
                        ) : (
                          <div className="history-entry">
                            <span className="history-dot" />
                            <div>
                              <strong>Observed in this sample audit</strong>
                              <p>23 Oct 2026 · readiness-v1</p>
                              {reviewed.includes(key(active)) && (
                                <p>
                                  You marked this finding reviewed in this
                                  browser session.
                                </p>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="next-action">
                        <span className="icon-well">
                          <CheckCircle2 size={20} />
                        </span>
                        <div>
                          <span className="muted small">Next action</span>
                          <h3>
                            {active.reasonCode === "EMPTY_TITLE"
                              ? "Write a descriptive page title"
                              : "Confirm the intended canonical"}
                          </h3>
                          <p>{copy(active).guidance}</p>
                          <div className="detail-actions">
                            <button
                              className="button button-secondary"
                              onClick={() => clipboard(copy(active).guidance)}
                            >
                              <Copy size={16} /> Copy guidance
                            </button>
                            <button
                              className="button button-primary"
                              onClick={() =>
                                setReviewed((v) =>
                                  v.includes(key(active))
                                    ? v.filter((k) => k !== key(active))
                                    : [...v, key(active)],
                                )
                              }
                            >
                              <Check size={17} />
                              {reviewed.includes(key(active))
                                ? "Mark unreviewed"
                                : "Mark reviewed"}
                            </button>
                          </div>
                          <p className="small muted review-explanation">
                            <Info size={14} /> Reviewed does not mean fixed.
                            Rerun after publishing a change.
                          </p>
                        </div>
                      </div>
                      <Link
                        className="visibility-callout"
                        href="/app/visibility"
                      >
                        <Sparkles size={20} />
                        <span>
                          <strong>AI visibility is measured separately</strong>
                          <small>
                            No live observations have been run for this site.
                          </small>
                        </span>
                        <ArrowUpRight size={18} />
                      </Link>
                    </>
                  ) : (
                    <div className="empty-state">
                      <CheckCircle2 />
                      <h2>No findings in this sample</h2>
                      <p>Inspect the audit scope and passed checks.</p>
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
          {view === "overview" && (
            <>
              <div className="overview-layout">
                <section className="overview-primary">
                  <span className="pill neutral">Latest sample audit</span>
                  <div className="overview-score">
                    <strong>{audit.score ?? "—"}</strong>
                    <div>
                      <h2>Search readiness</h2>
                      <p>
                        {issues.length} findings to review · 3 pages checked
                      </p>
                    </div>
                  </div>
                  <div className="coverage-bar">
                    <span
                      style={{ width: `${Math.round(audit.coverage * 100)}%` }}
                    />
                  </div>
                  <p className="small muted">
                    {Math.round(audit.coverage * 100)}% evidence coverage ·
                    readiness-v1 · Synthetic sample
                  </p>
                  <Link href="/app/audits" className="button button-primary">
                    Review the evidence <ArrowRight size={17} />
                  </Link>
                </section>
                <section className="next-move">
                  <span className="icon-well">
                    <CircleAlert size={22} />
                  </span>
                  <h2>Start with the page title.</h2>
                  <p>
                    The product page has an empty title. A focused fix gives
                    people a clearer first impression.
                  </p>
                  <Link className="text-link" href="/app/audits">
                    Inspect the finding <ArrowUpRight size={17} />
                  </Link>
                </section>
              </div>
              <section className="plain-section">
                <div className="section-title">
                  <h2>Your evidence sources</h2>
                  <Link href="/app/settings">
                    Manage connections <ArrowUpRight size={15} />
                  </Link>
                </div>
                {[
                  {
                    name: "Website readiness",
                    desc: "3 synthetic pages · completed",
                    href: "audits",
                    tag: "Sample available",
                  },
                  {
                    name: "AI visibility",
                    desc: "Azure API, consumer ChatGPT and Gemini",
                    href: "visibility",
                    tag: "Not connected",
                  },
                  {
                    name: "Search Console",
                    desc: "Read-only search performance",
                    href: "search",
                    tag: "Not connected",
                  },
                ].map((s) => (
                  <Link
                    key={s.name}
                    href={`/app/${s.href}`}
                    className="data-row"
                  >
                    <div>
                      <strong>{s.name}</strong>
                      <p>{s.desc}</p>
                    </div>
                    <span className="pill neutral">{s.tag}</span>
                    <ChevronRight size={17} />
                  </Link>
                ))}
              </section>
            </>
          )}
          {view === "sites" && (
            <section className="plain-section">
              <div className="section-title">
                <h2>Sample site</h2>
                <span className="pill neutral">No live crawl</span>
              </div>
              <div className="site-large">
                <span className="site-icon">
                  <Globe2 size={25} />
                </span>
                <div>
                  <h2>example.com</h2>
                  <p>Synthetic marketing website · 3 selected pages</p>
                </div>
                <Link href="/app/audits" className="button button-secondary">
                  View audit <ArrowRight size={16} />
                </Link>
              </div>
              <div
                className="simple-table"
                role="table"
                aria-label="Selected sample pages"
              >
                <div role="row" className="table-heading">
                  <span role="columnheader">Page</span>
                  <span role="columnheader">Evidence</span>
                  <span role="columnheader">Status</span>
                </div>
                {sampleEvidence(fixed).pages.map((p) => (
                  <div role="row" key={p.requestedUrl}>
                    <span role="cell">{new URL(p.requestedUrl).pathname}</span>
                    <span role="cell">Synthetic snapshot</span>
                    <span role="cell" className="success-text">
                      Acquired
                    </span>
                  </div>
                ))}
              </div>
              <p className="muted small">
                Real sites will require exact-origin verification before full
                acquisition. No verification claim is made for this sample.
              </p>
            </section>
          )}
          {view === "content" && (
            <div className="editor-layout">
              <section className="plain-section">
                <div className="section-title">
                  <h2>Working draft</h2>
                  <span className="pill neutral">Unsaved sample</span>
                </div>
                <label htmlFor="draft" className="field-label">
                  Product introduction
                </label>
                <textarea
                  id="draft"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={12}
                />
                <div className="editor-footer">
                  <span className="small muted">
                    {draft.length} characters · Browser session only
                  </span>
                  <button
                    className="button button-secondary"
                    onClick={() =>
                      download(
                        draft,
                        "sample-product-draft.md",
                        "text/markdown",
                      )
                    }
                  >
                    <Download size={16} /> Export draft
                  </button>
                </div>
              </section>
              <aside className="editor-context">
                <h2>Keep the evidence close.</h2>
                <p>
                  This editable sample lets you try the writing workspace. It
                  has not been generated by a model.
                </p>
                <div className="connection-row">
                  <Sparkles size={19} />
                  <div>
                    <strong>Azure OpenAI</strong>
                    <small>Not configured</small>
                  </div>
                </div>
                <p className="small muted">
                  Generation and Parallel research will become available after
                  their integrations, grounding checks and budget controls are
                  verified.
                </p>
                <Link href="/app/settings" className="text-link">
                  Connection details <ArrowUpRight size={16} />
                </Link>
              </aside>
            </div>
          )}
          {view === "visibility" && (
            <>
              <div className="surface-tabs" aria-label="Observation surface">
                {["Azure API", "Consumer ChatGPT", "Consumer Gemini"].map(
                  (s) => (
                    <button
                      key={s}
                      aria-pressed={surface === s}
                      className={s === surface ? "active" : ""}
                      onClick={() => setSurface(s)}
                    >
                      {s}
                    </button>
                  ),
                )}
              </div>
              <section className="empty-state large">
                <span className="empty-icon">
                  <Sparkles size={30} />
                </span>
                <h2>Your first observation starts here.</h2>
                <p>
                  {surface} has no observations yet. A missing measurement is
                  unavailable, not zero visibility.
                </p>
                <Link className="button button-secondary" href="/app/settings">
                  Review connection requirements <ArrowUpRight size={16} />
                </Link>
                <div className="measurement-notes">
                  <span>
                    <Check size={16} /> Exact surface and source
                  </span>
                  <span>
                    <Check size={16} /> Sample sizes alongside rates
                  </span>
                  <span>
                    <Check size={16} /> Comparable cohorts only
                  </span>
                </div>
              </section>
            </>
          )}
          {view === "search" && (
            <section className="empty-state large">
              <span className="empty-icon">
                <ChartNoAxesCombined size={30} />
              </span>
              <h2>Bring your search performance into view.</h2>
              <p>
                Read-only Google Search Console access will show clicks,
                impressions and position alongside their source dates. No
                connection has been configured.
              </p>
              <Link className="button button-secondary" href="/app/settings">
                Review connection requirements <ArrowUpRight size={16} />
              </Link>
              <p className="small muted">
                Google login and Search Console access are separate permissions.
              </p>
            </section>
          )}
          {view === "reports" && (
            <section className="plain-section">
              <div className="report-row">
                <div className="report-document">
                  <FileText size={35} />
                  <span>CSV</span>
                </div>
                <div>
                  <h2>Website readiness · example.com</h2>
                  <p>
                    3 pages · {audit.rules.length} rule results · readiness-v1
                  </p>
                  <span className="pill neutral">
                    Synthetic evidence · 23 Oct 2026
                  </span>
                </div>
                <button
                  className="button button-secondary"
                  onClick={() =>
                    download(
                      auditCsv(fixed),
                      "lyraseo-sample-audit.csv",
                      "text/csv;charset=utf-8",
                    )
                  }
                >
                  <Download size={17} /> Download CSV
                </button>
              </div>
              <p className="muted small">
                This export includes the actual local rule results. Branded PDF
                delivery and authenticated client sharing are upcoming phase-one
                work.
              </p>
            </section>
          )}
          {view === "settings" && (
            <>
              <section className="plain-section">
                <div className="section-title">
                  <h2>Provider connections</h2>
                  <span className="pill neutral">Local build</span>
                </div>
                {[
                  {
                    name: "Supabase Auth & PostgreSQL",
                    desc: "Identity, memberships and product persistence",
                  },
                  {
                    name: "Cloudflare Browser Run",
                    desc: "Bounded website acquisition and immutable evidence",
                  },
                  {
                    name: "Azure OpenAI",
                    desc: "Sol for substantive work; Luna for bounded helpers",
                  },
                  {
                    name: "Parallel Search / Extract",
                    desc: "Explicit cited research within its provider budget",
                  },
                  {
                    name: "DataForSEO Standard",
                    desc: "Consumer ChatGPT and Gemini observations",
                  },
                  {
                    name: "Gmail SMTP",
                    desc: "Private-pilot authentication and transactional delivery",
                  },
                ].map((p) => (
                  <div key={p.name} className="data-row">
                    <div>
                      <strong>{p.name}</strong>
                      <p>{p.desc}</p>
                    </div>
                    <span className="pill neutral">Not configured</span>
                  </div>
                ))}
                <div className="notice">
                  <ShieldCheck size={19} />
                  <span>
                    Credentials belong in server-side environment settings. This
                    build does not collect or save provider keys through the
                    browser.
                  </span>
                </div>
              </section>
              <section className="plain-section budget-section">
                <h2>The approved pilot budget</h2>
                <p>
                  Up to $10 per admitted user per UTC calendar month: $8 Azure,
                  $1 Parallel and $1 DataForSEO. This local sample makes no
                  provider calls and incurs no provider consumption.
                </p>
                <p className="small muted">
                  Paid upgrades require approval. Public plans and phase-two
                  features remain deferred.
                </p>
              </section>
            </>
          )}
          <footer className="app-footer">
            <span>LyraSEO AI · Evidence first.</span>
            <span>
              Private local build <span className="sample-dot" />
            </span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {notice}
          <button
            className="icon-button"
            onClick={() => setNotice("")}
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {dialog && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="rerun-title"
            className="modal"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !running) setDialog(false);
              if (e.key === "Tab") {
                const nodes = e.currentTarget.querySelectorAll<HTMLElement>(
                  "button:not(:disabled), input:not(:disabled), a[href]",
                );
                const first = nodes[0],
                  last = nodes[nodes.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <button
              autoFocus
              className="icon-button modal-close"
              aria-label="Close audit confirmation"
              disabled={running}
              onClick={() => setDialog(false)}
            >
              <X size={20} />
            </button>
            <span className="empty-icon">
              <ScanLine size={27} />
            </span>
            <h2 id="rerun-title">Rerun the sample audit</h2>
            <p>
              This evaluates three synthetic snapshots locally. It does not
              crawl example.com or contact any provider.
            </p>
            <label className="check-row">
              <input
                type="checkbox"
                checked={pendingFix}
                onChange={(e) => setPendingFix(e.target.checked)}
                disabled={running}
              />
              <span>
                Simulate publishing a descriptive product title
                <small>Changes only the synthetic title input.</small>
              </span>
            </label>
            <div className="rerun-scope">
              <span>Scope</span>
              <strong>3 pages · Same manifest</strong>
              <span>Provider consumption</span>
              <strong>$0 · No requests</strong>
            </div>
            <div className="modal-actions">
              <button
                className="button button-secondary"
                disabled={running}
                onClick={() => setDialog(false)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                disabled={running}
                onClick={() => setRunning(true)}
              >
                {running ? (
                  <>
                    <RefreshCw size={16} className="spin" /> Evaluating sample…
                  </>
                ) : (
                  <>
                    Run local evaluation <ArrowRight size={16} />
                  </>
                )}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
