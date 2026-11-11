"use client";
import { useRef, useState } from "react";
import { useClientReady } from "./use-client-ready";
import type { BatchPreview } from "@lyraseo/db/agency-batches";
export function AgencyBatches({
  workspaceId,
  sites,
}: {
  workspaceId: string;
  sites: { id: string; origin: string }[];
}) {
  const ready = useClientReady(),
    [selection, setSelection] = useState<string[]>([]),
    [kind, setKind] = useState("GENERATION"),
    [input, setInput] = useState(""),
    [preview, setPreview] = useState<BatchPreview | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(
      "Select at most ten explicit sites. Preview never reserves money. Unknown prices remain unavailable.",
    ),
    [result, setResult] = useState<{
      items: { ordinal: number; status: string; errorCode: string | null }[];
      admittedTotal: string;
    } | null>(null);
  const confirmationKey = useRef<string | null>(null);
  async function post(path: string, body: unknown) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok)
      throw Error(
        value.error ?? "Batch service unavailable. Selections are preserved.",
      );
    return value;
  }
  async function quote() {
    setBusy(true);
    setResult(null);
    try {
      const value = { request: input.trim() };
      const next = await post("/api/agency/batches/quote", {
        workspaceId,
        items: selection.map((siteId) => ({ siteId, kind, input: value })),
      });
      setPreview(next);
      confirmationKey.current = null;
      setMessage(
        next.unavailable
          ? "Provider pricing is not qualified. This selection cannot dispatch paid work."
          : "Review the exact selected sites and maximum charge before confirming.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Batch unavailable.");
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!preview) return;
    setBusy(true);
    try {
      confirmationKey.current ??= crypto.randomUUID();
      const next = await post("/api/agency/batches/confirm", {
        batchQuoteId: preview.batchQuoteId,
        confirmationHash: preview.confirmationHash,
        idempotencyKey: confirmationKey.current,
      });
      setResult(next);
      setMessage(
        "Saved batch outcomes loaded. Each admitted site has its own operation and allowance reservation.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Confirmation unavailable. Retry uses the same confirmation identity.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="pilot-card agency-controls"
      aria-labelledby="batch-heading"
    >
      <h2 id="batch-heading">Multi-site operation preview</h2>
      <p>
        One account pays for the selected operations within its existing
        partitions. No pooled budgets or automatic top-ups. Local raw audits use
        their separate acquisition journey.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void quote();
        }}
      >
        <fieldset disabled={!ready || busy}>
          <legend>Exact selected scope · {selection.length} of 10</legend>
          {sites.map((site) => (
            <label key={site.id} style={{ display: "block" }}>
              <input
                type="checkbox"
                checked={selection.includes(site.id)}
                disabled={
                  !selection.includes(site.id) && selection.length >= 10
                }
                onChange={() => {
                  setSelection((previous) =>
                    previous.includes(site.id)
                      ? previous.filter((id) => id !== site.id)
                      : [...previous, site.id],
                  );
                  setPreview(null);
                }}
              />
              {site.origin}
            </label>
          ))}
          <label htmlFor="batch-kind">Operation</label>
          <select
            id="batch-kind"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
              setPreview(null);
            }}
          >
            <option value="GENERATION">Editorial generation</option>
            <option value="RESEARCH">Explicit research</option>
            <option value="API_OBSERVATION">Azure API observation</option>
            <option value="CHATGPT_OBSERVATION">
              Consumer ChatGPT observation
            </option>
            <option value="GEMINI_OBSERVATION">
              Consumer Gemini observation
            </option>
          </select>
          <label htmlFor="batch-input">
            Describe the requested work for these sites
          </label>
          <textarea
            id="batch-input"
            rows={4}
            value={input}
            maxLength={4000}
            onChange={(event) => {
              setInput(event.target.value);
              setPreview(null);
            }}
          />
          <button
            className="button button-secondary"
            disabled={!selection.length}
          >
            Preview scope and maximum charge
          </button>
        </fieldset>
      </form>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {preview && (
        <div>
          <h3>Saved quote preview</h3>
          <p>
            Budget owner: your account. Currency USD. Expires{" "}
            {new Date(preview.expiresAt).toLocaleString()}.
          </p>
          <ul>
            {preview.items.map((item) => (
              <li key={item.ordinal}>
                {sites.find((site) => site.id === item.siteId)?.origin ??
                  item.siteId}
                :{" "}
                {item.maximumCost
                  ? `maximum $${item.maximumCost} · ${item.provider}`
                  : "price unavailable"}{" "}
                · {item.status.toLowerCase()}
              </li>
            ))}
          </ul>
          <p>
            Combined maximum:{" "}
            {preview.combinedMaximum === null
              ? "unavailable"
              : `$${preview.combinedMaximum}`}
          </p>
          <button
            type="button"
            className="button button-primary"
            disabled={!ready || busy || preview.unavailable}
            onClick={confirm}
          >
            Confirm exactly this scope and maximum cost
          </button>
        </div>
      )}
      {result && (
        <div>
          <h3>Saved batch outcomes</h3>
          <p>Admitted maximum: ${result.admittedTotal} USD</p>
          <ul>
            {result.items.map((item) => (
              <li key={item.ordinal}>
                Selected item {item.ordinal + 1}: {item.status.toLowerCase()}
                {item.errorCode ? ` · ${item.errorCode}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
