"use client";
import { useEffect, useState } from "react";
type Prompt = { id: string; text: string; label: "neutral" | "branded" };
type Brand = { id: string; name: string; aliases: string[]; domains: string[] };
type Panel = {
  id: string;
  version: number;
  prompts: Prompt[];
  brands: Brand[];
  reviewedAt: string | null;
};
type Run = {
  id: string;
  panelId: string;
  profile: string;
  createdAt: string;
  provenance: {
    synthetic?: boolean;
    provider?: string;
    model?: string;
    observedAt?: string;
  };
  slots: Array<{
    promptId: string;
    state: string;
    failureReason?: string | null;
    extraction: Record<
      string,
      {
        mention: boolean | null;
        citation: boolean | null;
        recommendation: boolean | null;
        reason: string | null;
      }
    >;
  }>;
  rawAnswers?: unknown;
  rawExpired: boolean;
};
type Saved = {
  panels: Panel[];
  runs: Run[];
  availability: { available: boolean; reason: string; profiles: string[] };
};
const labels: Record<string, string> = {
  "azure-sol-api": "Azure API",
  "consumer-chatgpt": "Consumer ChatGPT",
  "consumer-gemini": "Consumer Gemini",
};
const observation = (value: boolean | null) =>
  value === true
    ? "Present"
    : value === false
      ? "Measured absent"
      : "Uncertain";
export function VisibilityWorkspace({
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
  const [saved, setSaved] = useState<Saved | null>(null),
    [detail, setDetail] = useState<Run | null>(null);
  const [prompts, setPrompts] = useState<Prompt[]>([
    { id: "prompt-1", text: "", label: "neutral" },
  ]);
  const [brands, setBrands] = useState<Brand[]>([
    { id: "brand-1", name: "", aliases: [], domains: [] },
  ]);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("Loading saved panels and observations…");
  const query = `workspaceId=${encodeURIComponent(workspaceId)}&siteId=${encodeURIComponent(siteId)}`;
  async function request(
    command?: Record<string, unknown>,
    runId?: string,
  ): Promise<Saved | Panel> {
    const response = await fetch(
      `/api/visibility${command ? "" : `?${query}${runId ? `&runId=${encodeURIComponent(runId)}` : ""}`}`,
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
      throw new Error(
        value.reason ?? value.error ?? "Visibility evidence is unavailable.",
      );
    return value;
  }
  async function refresh() {
    setSaved((await request()) as Saved);
  }
  useEffect(() => {
    let active = true;
    fetch(`/api/visibility?${query}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            "Saved observations could not load. Refresh to retry.",
          );
        return response.json();
      })
      .then((value) => {
        if (active) {
          setSaved(value);
          setMessage("Review a prompt panel before requesting a measurement.");
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
        error instanceof Error
          ? error.message
          : "Unable to save. Your panel remains in the editor.",
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
      <section className="pilot-card" aria-labelledby="visibility-support">
        <h2 id="visibility-support">Collection support</h2>
        <p>
          English · India. Each surface keeps its actual provider, model, method
          and observation time. Audit readiness and search performance remain
          separate measures.
        </p>
        {saved && (
          <>
            <p>{saved.availability.reason}</p>
            <ul>
              {saved.availability.profiles.map((profile) => (
                <li key={profile}>
                  {labels[profile] ?? profile} ·{" "}
                  {saved.availability.available
                    ? "Available"
                    : "Collection unavailable"}
                </li>
              ))}
            </ul>
          </>
        )}
        <p role="status" aria-live="polite">
          {message}
        </p>
      </section>
      {editable && collectionEnabled && (
        <section className="pilot-card" aria-labelledby="panel-editor">
          <h2 id="panel-editor">Create a prompt-panel version</h2>
          <p>
            Use questions your audience would ask. A neutral prompt does not
            name your brand. Saved versions keep their original prompts and
            competitors.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const panel = (await request({
                  action: "create-panel",
                  prompts,
                  brands: brands.map((brand) => ({
                    ...brand,
                    domains: brand.domains.map((d) => d.trim()).filter(Boolean),
                    aliases: Array.from(
                      new Set(
                        [brand.name, ...brand.aliases]
                          .map((a) => a.trim())
                          .filter(Boolean),
                      ),
                    ),
                  })),
                })) as Panel;
                await refresh();
                setMessage(
                  `Panel version ${panel.version} saved. Review its questions and brands below.`,
                );
              });
            }}
          >
            <fieldset disabled={busy}>
              <legend>Questions (up to 25)</legend>
              {prompts.map((prompt, index) => (
                <div key={prompt.id}>
                  <label htmlFor={`prompt-${index}`}>
                    Question {index + 1}
                  </label>
                  <textarea
                    id={`prompt-${index}`}
                    className="audit-input"
                    rows={2}
                    value={prompt.text}
                    required
                    maxLength={4000}
                    onChange={(event) =>
                      setPrompts(
                        prompts.map((p, i) =>
                          i === index ? { ...p, text: event.target.value } : p,
                        ),
                      )
                    }
                  />
                  <label>
                    Question {index + 1} label
                    <select
                      className="audit-input"
                      value={prompt.label}
                      onChange={(event) =>
                        setPrompts(
                          prompts.map((p, i) =>
                            i === index
                              ? {
                                  ...p,
                                  label: event.target.value as Prompt["label"],
                                }
                              : p,
                          ),
                        )
                      }
                    >
                      <option value="neutral">Neutral</option>
                      <option value="branded">Branded</option>
                    </select>
                  </label>
                  {prompts.length > 1 && (
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() =>
                        setPrompts(prompts.filter((_, i) => i !== index))
                      }
                    >
                      Remove question {index + 1}
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                className="button button-secondary"
                disabled={prompts.length >= 25}
                onClick={() =>
                  setPrompts([
                    ...prompts,
                    { id: crypto.randomUUID(), text: "", label: "neutral" },
                  ])
                }
              >
                Add question
              </button>
            </fieldset>
            <fieldset disabled={busy}>
              <legend>Brands and competitors (up to 10)</legend>
              {brands.map((brand, index) => (
                <div key={brand.id}>
                  <label htmlFor={`brand-${index}`}>
                    Brand {index + 1} name
                  </label>
                  <input
                    id={`brand-${index}`}
                    className="audit-input"
                    value={brand.name}
                    required
                    maxLength={150}
                    onChange={(event) =>
                      setBrands(
                        brands.map((b, i) =>
                          i === index ? { ...b, name: event.target.value } : b,
                        ),
                      )
                    }
                  />
                  <label htmlFor={`aliases-${index}`}>
                    Brand {index + 1} aliases, one per line
                  </label>
                  <textarea
                    id={`aliases-${index}`}
                    className="audit-input"
                    rows={2}
                    value={brand.aliases.join("\n")}
                    onChange={(event) =>
                      setBrands(
                        brands.map((b, i) =>
                          i === index
                            ? {
                                ...b,
                                aliases: event.target.value.split(/\r?\n/),
                              }
                            : b,
                        ),
                      )
                    }
                  />
                  <label htmlFor={`domains-${index}`}>
                    Brand {index + 1} domains, one per line
                  </label>
                  <textarea
                    id={`domains-${index}`}
                    className="audit-input"
                    rows={2}
                    placeholder="example.com"
                    value={brand.domains.join("\n")}
                    onChange={(event) =>
                      setBrands(
                        brands.map((b, i) =>
                          i === index
                            ? {
                                ...b,
                                domains: event.target.value.split(/\r?\n/),
                              }
                            : b,
                        ),
                      )
                    }
                  />
                  {brands.length > 1 && (
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() =>
                        setBrands(brands.filter((_, i) => i !== index))
                      }
                    >
                      Remove brand {index + 1}
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                className="button button-secondary"
                disabled={brands.length >= 10}
                onClick={() =>
                  setBrands([
                    ...brands,
                    {
                      id: crypto.randomUUID(),
                      name: "",
                      aliases: [],
                      domains: [],
                    },
                  ])
                }
              >
                Add competitor
              </button>
            </fieldset>
            <button className="button button-primary" disabled={busy}>
              {busy ? "Saving…" : "Save panel version"}
            </button>
          </form>
        </section>
      )}
      <section className="pilot-card" aria-labelledby="saved-panels">
        <h2 id="saved-panels">Reviewed prompt panels</h2>
        {!saved?.panels.length && (
          <p>
            No saved panel yet. Collection results will only appear after an
            actual observation.
          </p>
        )}
        {saved?.panels.map((panel) => (
          <article key={panel.id}>
            <h3>Panel version {panel.version}</h3>
            <p>
              {panel.reviewedAt
                ? `Reviewed ${new Date(panel.reviewedAt).toLocaleString()}`
                : "Awaiting review"}
            </p>
            <ol>
              {panel.prompts.map((prompt) => (
                <li key={prompt.id}>
                  {prompt.text} <span className="muted">({prompt.label})</span>
                </li>
              ))}
            </ol>
            <ul>
              {panel.brands.map((brand) => (
                <li key={brand.id}>
                  {brand.name} · aliases: {brand.aliases.join(", ")} · domains:{" "}
                  {brand.domains.join(", ") || "None supplied"}
                </li>
              ))}
            </ul>
            {editable && collectionEnabled && (
              <div className="pilot-tabs">
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => {
                    setPrompts(panel.prompts.map((p) => ({ ...p })));
                    setBrands(
                      panel.brands.map((b) => ({
                        ...b,
                        aliases: [...b.aliases],
                        domains: [...b.domains],
                      })),
                    );
                    setMessage(
                      `Panel ${panel.version} copied into the editor. Saving creates a new version.`,
                    );
                    document
                      .getElementById("panel-editor")
                      ?.scrollIntoView({ block: "start" });
                  }}
                >
                  Copy into new version
                </button>
                {!panel.reviewedAt && (
                  <button
                    className="button button-primary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await request({
                          action: "review-panel",
                          panelId: panel.id,
                        });
                        await refresh();
                        setMessage(`Panel version ${panel.version} reviewed.`);
                      })
                    }
                  >
                    Mark version {panel.version} reviewed
                  </button>
                )}
              </div>
            )}
          </article>
        ))}
      </section>
      <section className="pilot-card" aria-labelledby="observation-history">
        <h2 id="observation-history">Observation evidence</h2>
        <p>
          Failed, unsupported and uncertain slots do not count as measured
          absence. Trends require ten common determinate prompts and 80%
          planned-slot coverage in both comparable windows.
        </p>
        {!saved?.runs.length && (
          <p>
            No observations collected. Presence, citations and share of voice
            are unmeasured.
          </p>
        )}
        <ul className="audit-history">
          {saved?.runs.map((run) => (
            <li key={run.id}>
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const result = (await request(undefined, run.id)) as Saved;
                    setDetail(result.runs[0] ?? null);
                    setMessage(
                      result.runs.length
                        ? "Observation evidence loaded."
                        : "This observation is no longer retained.",
                    );
                  })
                }
              >
                {labels[run.profile] ?? run.profile} ·{" "}
                {new Date(run.createdAt).toLocaleString()}
                {run.provenance.synthetic ? " · Synthetic fixture" : ""}
              </button>
            </li>
          ))}
        </ul>
        {detail && (
          <article>
            <h3>{labels[detail.profile] ?? detail.profile}</h3>
            {detail.provenance.synthetic && (
              <p>Synthetic fixture — this is not a live measurement.</p>
            )}
            <p>
              {detail.provenance.provider} · {detail.provenance.model} ·{" "}
              {new Date(detail.createdAt).toLocaleString()}
            </p>
            <div
              className="audit-table"
              role="region"
              aria-label="Per-prompt observation evidence table"
              tabIndex={0}
            >
              <table>
                <caption>Per-prompt evidence states</caption>
                <thead>
                  <tr>
                    <th>Prompt</th>
                    <th>State</th>
                    <th>Brand</th>
                    <th>Mention</th>
                    <th>Citation</th>
                    <th>Recommendation</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.slots.flatMap((slot) =>
                    Object.keys(slot.extraction).length === 0
                      ? [
                          <tr key={slot.promptId}>
                            <td>
                              {saved?.panels
                                .find((p) => p.id === detail.panelId)
                                ?.prompts.find((p) => p.id === slot.promptId)
                                ?.text ?? slot.promptId}
                            </td>
                            <td>{slot.state}</td>
                            <td colSpan={4}>
                              Not measured ·{" "}
                              {slot.failureReason ??
                                "No determinate answer evidence"}
                            </td>
                          </tr>,
                        ]
                      : Object.entries(slot.extraction).map(
                          ([brand, result]) => (
                            <tr key={`${slot.promptId}:${brand}`}>
                              <td>
                                {saved?.panels
                                  .find((p) => p.id === detail.panelId)
                                  ?.prompts.find((p) => p.id === slot.promptId)
                                  ?.text ?? slot.promptId}
                              </td>
                              <td>{slot.state}</td>
                              <td>
                                {saved?.panels
                                  .find((p) => p.id === detail.panelId)
                                  ?.brands.find((b) => b.id === brand)?.name ??
                                  brand}
                              </td>
                              <td>{observation(result.mention)}</td>
                              <td>{observation(result.citation)}</td>
                              <td>
                                {observation(result.recommendation)}
                                {result.reason && <p>{result.reason}</p>}
                              </td>
                            </tr>
                          ),
                        ),
                  )}
                </tbody>
              </table>
            </div>
            <details>
              <summary>Original answer evidence and provenance</summary>
              <pre className="audit-url">
                {JSON.stringify(detail.provenance, null, 2)}
              </pre>
              {detail.rawExpired ? (
                <p>
                  Raw answer retention has expired. Compact evidence remains
                  subject to its own retention.
                </p>
              ) : (
                <pre className="audit-url">
                  {JSON.stringify(detail.rawAnswers, null, 2)}
                </pre>
              )}
            </details>
          </article>
        )}
      </section>
    </>
  );
}
