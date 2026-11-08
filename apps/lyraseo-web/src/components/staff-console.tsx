"use client";
import styles from "./staff-console.module.css";
import { StaffJobControls } from "./staff-job-controls";
import { useSyncExternalStore, useState } from "react";
import type {
  SupportView,
  StaffView,
  StaffAction,
} from "@lyraseo/db/sandbox-billing";
type PendingStaffRequest = {
  requestId: string;
  action: StaffAction;
  target: string;
  args: Record<string, unknown>;
  reason: string;
};
export function StaffConsole({ initial }: { initial: SupportView }) {
  const [data, setData] = useState<
      SupportView & {
        nextKind?: "SITE" | "USER" | "WORKSPACE" | null;
        nextId?: string | null;
      }
    >(initial),
    [view, setView] = useState<StaffView>("controls"),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [resolution, setResolution] = useState<{
      requestState: string;
      committed?: boolean;
      canAbandon?: boolean;
      resultHash?: string;
      result?: Record<string, unknown>;
      reason?: string;
    } | null>(null),
    [reason, setReason] = useState(""),
    [subject, setSubject] = useState(""),
    [workspace, setWorkspace] = useState(""),
    [evidence, setEvidence] = useState(""),
    [notice, setNotice] = useState(""),
    [supportQuery, setSupportQuery] = useState(""),
    [supportMatch, setSupportMatch] = useState<"EXACT" | "PREFIX">("EXACT");
  const storageKey = `lyraseo.staff-request:${initial.actionPrincipalId ?? initial.actionContextId ?? "fixture-context"}`;
  const serialized = useSyncExternalStore(
    (listener) => {
      window.addEventListener("storage", listener);
      window.addEventListener("lyraseo-staff-request", listener);
      return () => {
        window.removeEventListener("storage", listener);
        window.removeEventListener("lyraseo-staff-request", listener);
      };
    },
    () => {
      try {
        return sessionStorage.getItem(storageKey);
      } catch {
        return "UNREADABLE";
      }
    },
    () => null,
  );
  let pending: PendingStaffRequest | null = null;
  if (serialized) {
    try {
      const parsed = JSON.parse(serialized) as PendingStaffRequest;
      if (
        typeof parsed.requestId === "string" &&
        typeof parsed.action === "string" &&
        typeof parsed.target === "string"
      )
        pending = parsed;
    } catch {
      /* Invalid browser data can never authorize a server action. */
    }
  }
  const serverPending = data.pendingRequests?.find(
    (item) => item.action && item.target && item.args && item.reason,
  );
  if (serverPending && serverPending.requestId !== pending?.requestId)
    pending = serverPending as PendingStaffRequest;
  function savePending(value: PendingStaffRequest | null) {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
    window.dispatchEvent(new Event("lyraseo-staff-request"));
  }
  async function send(body: unknown) {
    const response = await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    return result;
  }
  async function receiveResolution(
    saved: PendingStaffRequest,
    result: Record<string, unknown>,
  ) {
    const state = String(result.requestState);
    if (state === "ABANDONED") {
      savePending(null);
      setResolution(null);
      await load(view);
      setStatus(
        `Request ${saved.requestId} was confirmed unconsumed and abandoned. A fresh reviewed action is available.`,
      );
      return;
    }
    const resolved = {
      requestState: state,
      committed:
        result.committed === true ||
        ["COMMITTED", "ACKNOWLEDGED"].includes(state),
      canAbandon: result.canAbandon === true,
      resultHash: result.resultHash as string | undefined,
      result: result.result as Record<string, unknown> | undefined,
      reason: result.reason as string | undefined,
    };
    if (!resolved.result && resolved.committed) resolved.result = result;
    setResolution(resolved);
    setStatus(
      resolved.committed
        ? `Saved ${String(resolved.result?.state ?? "result")}. Review request ${saved.requestId} and acknowledge its existing result before another action.`
        : `Request ${saved.requestId}: ${state}${resolved.reason ? ` (${resolved.reason})` : ""}. Resolve or safely abandon the original before another action.`,
    );
  }
  async function sendRequest(saved: PendingStaffRequest) {
    setBusy(true);
    setStatus("");
    try {
      const prepared = await send({
        kind: "prepare-request",
        requestId: saved.requestId,
        action: saved.action,
        target: saved.target,
        args: saved.args,
        reason: saved.reason,
      });
      const result = prepared.requiresResolution
        ? await send({
            kind: "resolve-request",
            requestId: saved.requestId,
            choice: "STATUS",
          })
        : await send({ kind: "execute-request", requestId: saved.requestId });
      await receiveResolution(saved, result);
    } catch (error) {
      setStatus(
        `${error instanceof Error ? error.message : "Staff response lost."} The saved request remains uncertain. Resolve the same request before another action.`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function resolvePending(choice: "STATUS" | "ABANDON") {
    if (!pending) return;
    if (
      choice === "ABANDON" &&
      !window.confirm(
        "Abandon only if the server confirms this request never committed? A committed result will be recovered instead.",
      )
    )
      return;
    setBusy(true);
    try {
      await receiveResolution(
        pending,
        await send({
          kind: "resolve-request",
          requestId: pending.requestId,
          choice,
        }),
      );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Resolution unavailable; the request remains guarded.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function acknowledge() {
    if (!pending || !resolution?.resultHash) return;
    setBusy(true);
    try {
      await send({
        kind: "ack-request",
        requestId: pending.requestId,
        resultHash: resolution.resultHash,
      });
      savePending(null);
      setResolution(null);
      await load(view);
      setStatus(
        "The existing result is acknowledged. A new reviewed staff action is available.",
      );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Acknowledgement uncertain. Resolve the same request again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function load(
    next: StaffView,
    cursor?: string,
    searchCursor?: { kind: string; id: string },
  ) {
    setBusy(true);
    setStatus("");
    try {
      const query =
        next === "search"
          ? `view=search&query=${encodeURIComponent(supportQuery.trim())}&match=${supportMatch}${searchCursor ? `&cursorKind=${searchCursor.kind}&cursorId=${encodeURIComponent(searchCursor.id)}` : ""}`
          : `view=${next}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await fetch(`/api/admin?${query}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      setData(result);
      setView(next);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Unable to load staff records.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function action(
    name: StaffAction,
    target: string,
    args: Record<string, unknown>,
    summary: string,
  ) {
    if (!initial.actionContextId || !initial.actionPrincipalId) {
      setStatus(
        "The qualified staff action context is unavailable. No action was sent.",
      );
      return;
    }
    if (data.pendingRequests?.length && !pending) {
      setStatus(
        "A prior request requires its current named capability before it can be resolved. No new action was sent.",
      );
      return;
    }
    if (serialized && !pending) {
      setStatus(
        "Saved request data is unreadable. Resolve it before another action.",
      );
      return;
    }
    if (pending) {
      setStatus(
        "Resolve the saved uncertain request before another staff action.",
      );
      return;
    }
    if (reason.trim().length < 12) {
      setStatus("Enter a reason of at least12characters.");
      return;
    }
    if (!window.confirm(summary)) return;
    const saved = {
      requestId: crypto.randomUUID(),
      action: name,
      target,
      args,
      reason: reason.trim(),
    };
    // The persisted request contains no step-up, provider, browser-session or DB secret.
    try {
      savePending(saved);
    } catch {
      setStatus(
        "This browser cannot preserve an action safely across refresh. No action was sent.",
      );
      return;
    }
    await sendRequest(saved);
  }
  return (
    <section className={styles.console} aria-label="Private staff controls">
      <nav
        aria-label="Staff views"
        style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}
      >
        {(
          [
            "controls",
            "search",
            "privacy",
            "billing",
            "deliveries",
            "jobs",
            "operations",
            "usage",
            "recovery",
            "audit",
          ] as const
        ).map((name) => (
          <button
            key={name}
            type="button"
            disabled={busy}
            aria-current={view === name ? "page" : undefined}
            onClick={() => {
              if (name === "search") {
                setView("search");
                setData((previous) => ({
                  ...previous,
                  rows: [],
                  nextCursor: null,
                  nextKind: null,
                  nextId: null,
                }));
                setStatus("");
              } else {
                void load(name);
              }
            }}
          >
            {name[0]!.toUpperCase() + name.slice(1)}
          </button>
        ))}
      </nav>
      <p id="staff-status" role="status" aria-live="polite">
        {busy ? "Loading staff state…" : status}
      </p>
      {pending && (
        <section aria-label="Uncertain staff request">
          <p>
            Saved request {pending.requestId}. Its result may already exist;
            retrying reuses the same server request.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => sendRequest(pending)}
          >
            Retry saved request
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => resolvePending("STATUS")}
          >
            Check saved request status
          </button>
          {resolution?.canAbandon && (
            <button
              type="button"
              disabled={busy}
              onClick={() => resolvePending("ABANDON")}
            >
              Safely abandon unconsumed request
            </button>
          )}
          {resolution?.committed && (
            <>
              <p>
                Existing result:{" "}
                {String(resolution.result?.state ?? "Recorded")}{" "}
                {String(resolution.result?.id ?? "")}
              </p>
              <button
                type="button"
                disabled={busy || !resolution.resultHash}
                onClick={acknowledge}
              >
                Acknowledge saved result
              </button>
            </>
          )}
        </section>
      )}
      {view === "search" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void load("search");
          }}
        >
          <fieldset
            disabled={busy || !data.permissions.includes("support:search")}
          >
            <legend>Find an opaque product identifier</legend>
            <label htmlFor="support-query">
              Exact ID or selective literal prefix
            </label>
            <input
              id="support-query"
              value={supportQuery}
              onChange={(event) => {
                setSupportQuery(event.target.value);
                setData((previous) => ({
                  ...previous,
                  rows: [],
                  nextKind: null,
                  nextId: null,
                }));
              }}
              minLength={supportMatch === "PREFIX" ? 12 : 8}
              maxLength={128}
              pattern="[A-Za-z0-9_-]+"
              required
              aria-describedby="support-search-hint"
            />
            <label htmlFor="support-match">Match</label>
            <select
              id="support-match"
              value={supportMatch}
              onChange={(event) => {
                setSupportMatch(event.target.value as "EXACT" | "PREFIX");
                setData((previous) => ({
                  ...previous,
                  rows: [],
                  nextKind: null,
                  nextId: null,
                }));
              }}
            >
              <option value="EXACT">
                Exact identifier (at least8characters)
              </option>
              <option value="PREFIX">
                Literal prefix (at least12characters)
              </option>
            </select>
            <p id="support-search-hint">
              Search only user, workspace or site IDs. Prefixes treat
              underscores literally. Emails, domains and content are
              unavailable. Fresh MFA and named support permission are required.
            </p>
            <button type="submit">Search support identifiers</button>
          </fieldset>
        </form>
      )}
      {view === "privacy" && (
        <p role="status">
          {data.available === false
            ? "Privacy case projection unavailable: the qualified retention migration and read adapter are not installed."
            : "Local privacy evidence. Pending processor or backup adapters remain explicit; these records do not prove all-copy erasure."}
        </p>
      )}
      {["controls", "recovery", "jobs"].includes(view) && (
        <>
          <label htmlFor="staff-reason">Reason for staff action</label>
          <textarea
            id="staff-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            aria-describedby="staff-status"
            style={{ width: "100%", maxWidth: "40rem" }}
          />
          <p>
            Requests require MFA within the past ten minutes and a named staff
            permission.{" "}
            {view === "controls"
              ? "Queued staff pause execution is unavailable until authoritative current provider-session revocation/expiry can be revalidated. Cached session history is insufficient."
              : view === "recovery"
                ? "Recovery completion requires a supported provider flow and verified notices."
                : "Reconciliation requests read saved sandbox bindings and cannot initiate charges."}
          </p>
        </>
      )}
      {view === "recovery" && data.permissions.includes("recovery:manage") && (
        <fieldset disabled={busy}>
          <legend>Local recovery rehearsal</legend>
          <label htmlFor="recovery-subject">Exact product user ID</label>
          <input
            id="recovery-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            maxLength={128}
          />
          <label htmlFor="recovery-workspace">Workspace ID (optional)</label>
          <input
            id="recovery-workspace"
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            maxLength={128}
          />
          <button
            type="button"
            disabled={!subject.trim()}
            onClick={() =>
              action(
                "recovery:open",
                subject.trim(),
                workspace.trim() ? { workspaceId: workspace.trim() } : {},
                "Open a local recovery rehearsal? This does not freeze an account or reset a factor.",
              )
            }
          >
            Open rehearsal case
          </button>
          <label htmlFor="recovery-evidence">
            Accepted independent evidence receipt SHA-256
          </label>
          <input
            id="recovery-evidence"
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            maxLength={64}
          />
          <label htmlFor="recovery-notice">
            Previously verified channel notice receipt SHA-256
          </label>
          <input
            id="recovery-notice"
            value={notice}
            onChange={(event) => setNotice(event.target.value)}
            maxLength={64}
          />
          <p>
            Use redacted synthetic receipts here. This rehearsal does not
            deliver notices or collect identity documents.
          </p>
        </fieldset>
      )}
      {view === "operations" && (
        <StaffJobControls
          rows={data.rows}
          permissions={data.permissions}
          onChanged={() => load("operations")}
        />
      )}
      {data.rows.length === 0 ? (
        <p>No {view} records are available.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {data.rows.map((row, index) => (
            <li
              key={String(row.id ?? row.key ?? index)}
              style={{
                border: "1px solid var(--border)",
                borderRadius: "0.75rem",
                padding: "1rem",
                marginBlock: "0.75rem",
                overflowWrap: "anywhere",
              }}
            >
              <dl>
                {Object.entries(row).map(([key, value]) => (
                  <div
                    key={key}
                    style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}
                  >
                    <dt>{key.replaceAll("_", " ")}</dt>
                    <dd style={{ margin: 0 }}>
                      {value === null ? (
                        "Unavailable"
                      ) : typeof value === "object" ? (
                        <pre
                          style={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {JSON.stringify(value, null, 2)}
                        </pre>
                      ) : (
                        String(value)
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              {view === "controls" && (
                <button
                  type="button"
                  disabled
                  title="Authoritative provider-session revocation/expiry revalidation is unavailable."
                >
                  Staff pause unavailable for {String(row.key)}
                </button>
              )}
              {view === "jobs" &&
                data.permissions.includes("billing:reconcile") && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      action(
                        "billing:reconcile",
                        String(row.id),
                        {},
                        "Request a canonical sandbox read? This cannot charge or refund a customer.",
                      )
                    }
                  >
                    Request reconciliation
                  </button>
                )}
              {view === "recovery" &&
                data.permissions.includes("recovery:manage") && (
                  <div
                    style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}
                  >
                    {row.state === "VERIFYING" && (
                      <button
                        type="button"
                        disabled={
                          busy ||
                          !/^[a-f0-9]{64}$/.test(evidence) ||
                          !/^[a-f0-9]{64}$/.test(notice)
                        }
                        onClick={() =>
                          action(
                            "recovery:hold",
                            String(row.id),
                            {
                              expectedRevision: Number(row.revision),
                              evidenceHash: evidence,
                              noticeReceiptHash: notice,
                            },
                            "Accept the rehearsal evidence and notice receipts and begin a minimum72-hour hold?",
                          )
                        }
                      >
                        Begin 72-hour hold
                      </button>
                    )}
                    {row.state === "HOLD" && (
                      <button
                        type="button"
                        disabled={busy || row.can_approve !== true}
                        onClick={() =>
                          action(
                            "recovery:approve",
                            String(row.id),
                            { expectedRevision: Number(row.revision) },
                            "Record an independent recovery approval? Factor replacement remains unavailable.",
                          )
                        }
                      >
                        Approve after hold
                      </button>
                    )}
                    {["VERIFYING", "HOLD"].includes(String(row.state)) && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          action(
                            "recovery:deny",
                            String(row.id),
                            { expectedRevision: Number(row.revision) },
                            "Deny this recovery rehearsal and preserve existing account access?",
                          )
                        }
                      >
                        Deny case
                      </button>
                    )}
                    <button
                      type="button"
                      disabled
                      title="Supported provider factor replacement, revocation and notices are not qualified."
                    >
                      Completion unavailable
                    </button>
                  </div>
                )}
            </li>
          ))}
        </ul>
      )}
      {view === "search" && data.nextKind && data.nextId && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            load("search", undefined, {
              kind: data.nextKind!,
              id: data.nextId!,
            })
          }
        >
          Next support results
        </button>
      )}
      {data.nextCursor && (
        <button
          type="button"
          disabled={busy}
          onClick={() => load(view, data.nextCursor!)}
        >
          Next {data.limit} records
        </button>
      )}
      {view === "recovery" && (
        <p>
          Recovery records are a local rehearsal. The 72-hour hold and
          independent decision do not replace verified-channel notices or a
          supported factor replacement flow. Completion remains unavailable.
        </p>
      )}
    </section>
  );
}
