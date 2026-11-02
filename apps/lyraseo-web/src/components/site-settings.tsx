"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SiteContext } from "@lyraseo/db/sites";
type Revision = {
  id: string;
  revision: number;
  content: SiteContext;
  reviewedBy: string;
  reviewedAt: string;
};
const blank = (): SiteContext => ({
  audience: "",
  positioning: "",
  conversionGoal: "",
  brandName: "",
  approvedAliases: [],
  competitors: [],
  keyPages: [],
  supportedClaims: [],
  editorialPreferences: "",
});
const labels: Record<keyof SiteContext, string> = {
  audience: "Audience",
  positioning: "Positioning",
  conversionGoal: "Conversion goal",
  brandName: "Brand name",
  approvedAliases: "Approved aliases",
  competitors: "Competitors",
  keyPages: "Key page URLs",
  supportedClaims: "Supported claims",
  editorialPreferences: "Editorial preferences",
};
async function command(input: object) {
  const response = await fetch("/api/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "The site could not be updated.");
  return result;
}
export function CreateSite({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [origin, setOrigin] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          const site = await command({ action: "create", workspaceId, origin });
          router.push(
            `/app/sites/${encodeURIComponent(site.id)}/settings?workspaceId=${encodeURIComponent(workspaceId)}`,
          );
          router.refresh();
        } catch (error) {
          setError(
            error instanceof Error ? error.message : "Unable to add site.",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Add a site</h3>
      <label htmlFor="site-origin">Public HTTPS origin</label>
      <input
        id="site-origin"
        className="audit-input"
        type="url"
        required
        maxLength={2048}
        placeholder="https://example.com"
        value={origin}
        onChange={(e) => setOrigin(e.target.value)}
        disabled={busy}
      />
      <p>
        Enter the origin only, without a page path or query. Ownership
        verification follows.
      </p>
      <button className="button button-primary" disabled={busy}>
        {busy ? "Adding site…" : "Add site"}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
export function SiteSettings({
  workspaceId,
  siteId,
  editable,
  manager,
  contextEnabled = true,
  proofEnabled = true,
  enabled,
  initialRevisions,
  verifiedAt,
}: {
  workspaceId: string;
  siteId: string;
  editable: boolean;
  manager: boolean;
  contextEnabled?: boolean;
  proofEnabled?: boolean;
  enabled: boolean;
  initialRevisions: Revision[];
  verifiedAt: string | null;
}) {
  const [revisions, setRevisions] = useState(initialRevisions),
    [draft, setDraft] = useState<SiteContext>(
      initialRevisions[0]?.content ?? blank(),
    ),
    [expected, setExpected] = useState(initialRevisions[0]?.revision ?? 0);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [verified, setVerified] = useState(verifiedAt);
  const [challenge, setChallenge] = useState<{
    id: string;
    token: string;
    url: string;
    expiresAt: string;
  } | null>(null);
  const scope = { workspaceId, siteId };
  async function execute(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to update site.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {(!contextEnabled || !proofEnabled) && (
        <p className="notice" role="status">
          {!contextEnabled ? "Context changes are paused. " : ""}
          {!proofEnabled ? "Ownership proof collection is paused. " : ""}Saved
          context and ownership evidence remain readable.
        </p>
      )}
      <section className="pilot-card" aria-labelledby="ownership-heading">
        <h2 id="ownership-heading">Ownership verification</h2>
        <p>
          {verified
            ? `Ownership evidence recorded ${new Date(verified).toLocaleString()}. A fresh check is needed after 24 hours.`
            : "Ownership has not been verified."}
        </p>
        {manager && (
          <>
            <p>
              Publish the issued token as the complete text of the verification
              file on this exact origin. A new challenge replaces any previous
              outstanding challenge.
            </p>
            <button
              className="button button-secondary"
              disabled={busy || !proofEnabled}
              onClick={() =>
                execute(async () => {
                  setChallenge(
                    await command({ ...scope, action: "challenge" }),
                  );
                  setMessage(
                    "Challenge issued. Save the token now; it is shown only in this session.",
                  );
                })
              }
            >
              Issue new challenge
            </button>
            {challenge && (
              <div>
                <p>
                  File URL:{" "}
                  <a href={challenge.url} target="_blank" rel="noreferrer">
                    {challenge.url}
                  </a>
                </p>
                <label htmlFor="proof-token">One-time token</label>
                <textarea
                  id="proof-token"
                  className="audit-input"
                  value={challenge.token}
                  readOnly
                  rows={2}
                />
                <p>Expires {new Date(challenge.expiresAt).toLocaleString()}.</p>
                <button
                  className="button button-primary"
                  disabled={busy || !enabled || !proofEnabled}
                  onClick={() =>
                    execute(async () => {
                      await command({
                        ...scope,
                        action: "verify",
                        challengeId: challenge.id,
                      });
                      setVerified(new Date().toISOString());
                      setChallenge(null);
                      setMessage("Ownership verified from the published file.");
                    })
                  }
                >
                  Verify published file
                </button>
              </div>
            )}
            {!enabled && (
              <p className="notice">
                Verification checks require qualified local operator
                configuration. You can prepare the file now.
              </p>
            )}
          </>
        )}
      </section>
      <section className="pilot-card" aria-labelledby="context-heading">
        <h2 id="context-heading">Reviewed site context</h2>
        <p>
          Record facts your team has reviewed. Empty fields stay unspecified;
          nothing is inferred. Current revision: {revisions[0]?.revision ?? 0}.
        </p>
        {editable && contextEnabled ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void execute(async () => {
                const content = { ...draft };
                for (const key of [
                  "approvedAliases",
                  "competitors",
                  "keyPages",
                  "supportedClaims",
                ] as const) {
                  content[key] = draft[key]
                    .map((item) => item.trim())
                    .filter(Boolean);
                  if (
                    content[key].length > 25 ||
                    content[key].some((item) => item.length > 2048)
                  )
                    throw new Error(
                      "Use up to 25 entries per list, each at most 2048 characters.",
                    );
                }
                const revision = await command({
                  ...scope,
                  action: "context",
                  expectedRevision: expected,
                  content,
                });
                setRevisions([revision, ...revisions]);
                setExpected(revision.revision);
                setMessage(`Saved reviewed revision ${revision.revision}.`);
              });
            }}
          >
            {(Object.keys(labels) as (keyof SiteContext)[]).map((key) => {
              const list = Array.isArray(draft[key]);
              return (
                <div key={key}>
                  <label htmlFor={`context-${key}`}>
                    {labels[key]}
                    {list ? " (one per line, up to 25)" : ""}
                  </label>
                  <textarea
                    className="audit-input"
                    id={`context-${key}`}
                    rows={list ? 4 : 3}
                    maxLength={list ? 32768 : key === "brandName" ? 512 : 4000}
                    disabled={busy}
                    value={
                      list
                        ? (draft[key] as string[]).join("\n")
                        : (draft[key] as string)
                    }
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        [key]: list
                          ? e.target.value.split("\n")
                          : e.target.value,
                      })
                    }
                  />
                </div>
              );
            })}
            <button className="button button-primary" disabled={busy}>
              {busy ? "Working…" : "Save reviewed context"}
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() =>
                execute(async () => {
                  const response = await fetch(
                    `/api/sites?workspaceId=${encodeURIComponent(workspaceId)}&siteId=${encodeURIComponent(siteId)}`,
                    { cache: "no-store" },
                  );
                  const rows = await response.json();
                  if (!response.ok) throw new Error(rows.error);
                  setRevisions(rows);
                  setMessage(
                    "History refreshed. Your unsaved draft is preserved. Load the current revision to replace it before saving against a newer revision.",
                  );
                })
              }
            >
              Refresh history, keep draft
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => {
                setDraft(revisions[0]?.content ?? blank());
                setExpected(revisions[0]?.revision ?? 0);
                setError("");
                setMessage(
                  "Loaded current revision; previous unsaved changes were replaced.",
                );
              }}
            >
              Replace draft with current revision
            </button>
            <p>
              Editing from revision {expected}. If another reviewer saves first,
              your draft is preserved. Refresh history, then load the current
              revision to reconcile.
            </p>
          </form>
        ) : (
          <p>
            You can read reviewed revisions. An editor can update this context.
          </p>
        )}
        <h3>Revision history</h3>
        {revisions.length ? (
          revisions.map((revision) => (
            <details key={revision.id}>
              <summary>
                Revision {revision.revision} ·{" "}
                {new Date(revision.reviewedAt).toLocaleString()} · reviewed by{" "}
                {revision.reviewedBy}
              </summary>
              <dl>
                {(Object.keys(labels) as (keyof SiteContext)[]).map((key) => (
                  <div key={key}>
                    <dt>{labels[key]}</dt>
                    <dd>
                      {Array.isArray(revision.content[key])
                        ? (revision.content[key] as string[]).join("; ") ||
                          "Unspecified"
                        : revision.content[key] || "Unspecified"}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ))
        ) : (
          <p>No reviewed context yet.</p>
        )}
      </section>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
