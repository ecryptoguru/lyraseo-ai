"use client";
import { useEffect, useState } from "react";
type Prompt = { id: string; text: string; label: "neutral" | "branded" };
type Brand = { id: string; name: string; aliases: string[]; domains: string[] };
type Profile = "azure-sol-api" | "consumer-chatgpt" | "consumer-gemini";
type Allowance = {
  bucket: string;
  limit: string;
  spent: string;
  reserved: string;
  remaining: string;
  overLimit: boolean;
};
type Preview = {
  available: false;
  panel: { id: string; version: number; promptCount: number };
  requested: { profile: Profile; language: "en"; market: "IN" };
  verification: "current" | "required";
  incompatiblePromptIds: string[];
  quote: null;
  maximumCost: null;
  cacheStatus: "not-checked";
  allowance: {
    asOf: string;
    period: string;
    combined: Allowance;
    provider: Allowance;
    observations: Allowance;
  };
  reasons: string[];
};
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
  storageFormat?: string | null;
  rawAvailability?: Array<{
    promptId: string;
    state: string;
    representation: string;
    producerClass: string;
    originalProviderWire: false;
  }>;
  rawAnswers?: unknown;
  rawState?:
    | "retained"
    | "raw-expired"
    | "raw-erased"
    | "not-retained-unverified"
    | "classification-blocked"
    | "private";
  otherFieldResidual?: string;
  rawExpired: boolean;
};
type Saved = {
  panels: Panel[];
  runs: Run[];
  availability: {
    available: boolean;
    reason: string;
    profiles: string[];
    profileCapabilities?: {
      profile: string;
      available: boolean;
      reasons: string[];
    }[];
  };
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
  const [preview, setPreview] = useState<Preview | null>(null);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
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
  ): Promise<Saved | Panel | Preview> {
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
                  {saved.availability.profileCapabilities
                    ?.find((item) => item.profile === profile)
                    ?.reasons.map((reason) => (
                      <p key={reason}>{reason}</p>
                    ))}
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
                {panel.reviewedAt && (
                  <div>
                    <label htmlFor={`surface-${panel.id}`}>
                      Surface for panel version {panel.version}
                    </label>
                    <select
                      id={`surface-${panel.id}`}
                      className="audit-input"
                      disabled={busy}
                      value={profiles[panel.id] ?? "azure-sol-api"}
                      onChange={(event) => {
                        setProfiles({
                          ...profiles,
                          [panel.id]: event.target.value as Profile,
                        });
                        setPreview(null);
                      }}
                    >
                      {Object.entries(labels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() => {
                        setPreview(null);
                        void perform(async () => {
                          const result = (await request({
                            action: "preview-run",
                            panelId: panel.id,
                            profile: profiles[panel.id] ?? "azure-sol-api",
                          })) as Preview;
                          setPreview(result);
                          setMessage(
                            "Scope and allowance preview loaded. No collection was started.",
                          );
                        });
                      }}
                    >
                      Preview scope and allowance
                    </button>
                  </div>
                )}
              </div>
            )}
            {preview?.panel.id === panel.id && (
              <section
                className="pilot-card"
                aria-label="Observation run preview"
              >
                <h4>Observation run preview</h4>
                <p>
                  {labels[preview.requested.profile]} ·{" "}
                  {preview.panel.promptCount}{" "}
                  {preview.panel.promptCount === 1 ? "question" : "questions"} ·
                  English · intended market India
                </p>
                <p>
                  No quote or collection has been started. Maximum cost is
                  unavailable until the provider is qualified.
                </p>
                <p>
                  Allowance snapshot for {preview.allowance.period} UTC, at{" "}
                  {new Date(preview.allowance.asOf).toISOString()}; allowance
                  can change before a future request.
                </p>
                <dl>
                  <dt>Combined allowance</dt>
                  <dd>
                    {preview.allowance.combined.remaining} USD remaining of{" "}
                    {preview.allowance.combined.limit} USD
                  </dd>
                  <dt>Provider allowance</dt>
                  <dd>
                    {preview.allowance.provider.remaining} USD remaining of{" "}
                    {preview.allowance.provider.limit} USD
                  </dd>
                  <dt>Surface allowance</dt>
                  <dd>
                    {preview.allowance.observations.remaining} observations
                    remaining of {preview.allowance.observations.limit}
                  </dd>
                </dl>
                {[
                  preview.allowance.combined,
                  preview.allowance.provider,
                  preview.allowance.observations,
                ].some((item) => item.overLimit) && (
                  <p>
                    Recorded usage exceeds an allowance. Reconciliation is
                    required before further admission.
                  </p>
                )}
                <p>
                  {preview.verification === "current"
                    ? "Site verification is current for admission."
                    : "Verify the site again before an observation can be admitted."}
                </p>
                {preview.incompatiblePromptIds.length > 0 && (
                  <p>
                    These question IDs exceed the current consumer connector
                    length limit and need a shorter reviewed panel:{" "}
                    <span className="audit-url">
                      {preview.incompatiblePromptIds.join(", ")}
                    </span>
                    .
                  </p>
                )}
                <p>Saved result reuse has not been checked.</p>
                <ul>
                  {preview.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </section>
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
              <summary>Parsed answer evidence and provenance</summary>
              <pre className="audit-url">
                {JSON.stringify(detail.provenance, null, 2)}
              </pre>
              {detail.storageFormat === "OBSERVATION_PRIVATE_V1" ? (
                <>
                  <p>
                    Synthetic controlled fixture evidence. Retained answers are
                    parsed JSON, not original provider responses. Original
                    provider wire is unavailable.
                  </p>
                  <ul>
                    {detail.rawAvailability?.map((slot) => (
                      <li key={slot.promptId}>
                        {slot.promptId}:{" "}
                        {slot.state === "retained-parsed"
                          ? "retained parsed answer"
                          : slot.state === "expired"
                            ? "raw answer expired"
                            : slot.state === "rights-unavailable"
                              ? "raw answer rights unavailable"
                              : slot.state === "not-retained"
                                ? "no answer body retained"
                                : "raw answer unavailable"}
                        .{" "}
                        {slot.state === "retained-parsed" && (
                          <a
                            href={`/api/visibility?${query}&runId=${encodeURIComponent(detail.id)}&promptId=${encodeURIComponent(slot.promptId)}&action=read-answer`}
                          >
                            Read parsed answer for {slot.promptId}
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <p>
                    Legacy answers are stored as parsed JSON, not original
                    provider responses.
                  </p>
                  {detail.rawState === "retained" ? (
                    <pre className="audit-url">
                      {JSON.stringify(detail.rawAnswers, null, 2)}
                    </pre>
                  ) : detail.rawState === "raw-erased" ? (
                    <p>
                      The raw answer field was cleared under the recorded
                      retention transition.
                    </p>
                  ) : detail.rawState === "raw-expired" ? (
                    <p>
                      Raw answer retention has expired; clearing has not been
                      confirmed.
                    </p>
                  ) : detail.rawState === "not-retained-unverified" ? (
                    <p>
                      No raw answer is retained; a clearing receipt is
                      unavailable.
                    </p>
                  ) : (
                    <p>The raw answer is unavailable pending classification.</p>
                  )}
                  <p>
                    Other stored fields may contain copies and remain
                    unclassified. Measurements have a separate retention period.
                  </p>
                </>
              )}
            </details>
          </article>
        )}
      </section>
    </>
  );
}
