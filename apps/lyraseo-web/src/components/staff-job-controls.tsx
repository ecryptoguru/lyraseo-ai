"use client";
import { useEffect, useRef, useState } from "react";
import type { StaffJobAction } from "@lyraseo/db/staff-job-control";

type PendingJob = {
  action: StaffJobAction;
  target: string;
  expectedFence: number;
  requestId: string;
};
type Row = Record<string, unknown>;
const pendingKey = "lyraseo-staff-job-pending-v1";

export function StaffJobControls({
  rows,
  permissions,
  onChanged,
}: {
  rows: Row[];
  permissions: string[];
  onChanged: () => Promise<void>;
}) {
  const [available, setAvailable] = useState(false);
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [pending, setPending] = useState<PendingJob | null>(null);
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        const raw = sessionStorage.getItem(pendingKey);
        if (raw) {
          const value: unknown = JSON.parse(raw);
          if (!value || typeof value !== "object")
            throw Error("INVALID_PENDING");
          const p = value as Record<string, unknown>;
          if (
            (p.action !== "jobs:retry" && p.action !== "jobs:cancel") ||
            typeof p.target !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(p.target) ||
            typeof p.expectedFence !== "number" ||
            !Number.isSafeInteger(p.expectedFence) ||
            p.expectedFence < 0 ||
            typeof p.requestId !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(p.requestId)
          )
            throw Error("INVALID_PENDING");
          if (active) setPending(p as PendingJob);
        }
      } catch {
        if (active) {
          setBlocked(true);
          setStatus(
            "Unable to read the pending request reference. Review the audit trail before starting another action.",
          );
        }
      }
      try {
        const response = await fetch("/api/admin/jobs", { cache: "no-store" });
        if (response.ok) {
          const result = await response.json();
          if (active)
            setAvailable(
              result.available === true && result.profile === "LOCAL_REHEARSAL",
            );
        }
      } catch {
        // No qualification is claimed when the status request is unavailable.
      } finally {
        if (active) setReady(true);
      }
    }
    void initialize();
    return () => {
      active = false;
    };
  }, []);
  async function execute(p: PendingJob) {
    if (inFlight.current) return;
    if (reason.trim().length < 12) {
      setStatus("Enter the original reason of at least 12 characters.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const payload = { ...p, reason: reason.trim() };
      for (const kind of ["prepare", "execute"] as const) {
        const response = await fetch("/api/admin/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, ...payload }),
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.error);
        if (kind === "execute") {
          sessionStorage.removeItem(pendingKey);
          setPending(null);
          await onChanged();
          setStatus(
            result.reconciliationRequired
              ? "Cancellation recorded. Provider reconciliation is required; the reservation remains held."
              : `Job ${result.status}. Delivery remains unavailable in this local rehearsal.`,
          );
        }
      }
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `${error.message} The pending request is retained; use the same reason to resume or check its result.`
          : "Request pending. Check its result before trying again.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function start(
    action: StaffJobAction,
    target: string,
    expectedFence: number,
  ) {
    if (inFlight.current || pending || !available || !ready || blocked) return;
    if (reason.trim().length < 12) {
      setStatus("Enter a reason of at least 12 characters.");
      return;
    }
    if (
      !window.confirm(
        `${action === "jobs:retry" ? "Retry" : "Cancel"} this operation in the local rehearsal? Accepted provider work requires reconciliation.`,
      )
    )
      return;
    inFlight.current = true;
    setBusy(true);
    let p: PendingJob;
    try {
      const response = await fetch("/api/admin/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "allocate" }),
      });
      const allocation: unknown = await response.json();
      if (
        !response.ok ||
        !allocation ||
        typeof allocation !== "object" ||
        !("requestId" in allocation) ||
        typeof allocation.requestId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(allocation.requestId)
      )
        throw Error("Unable to allocate the request.");
      p = { action, target, expectedFence, requestId: allocation.requestId };
      sessionStorage.setItem(pendingKey, JSON.stringify(p));
      setPending(p);
    } catch {
      setStatus(
        "Unable to reserve a request reference. No job action was started.",
      );
      inFlight.current = false;
      setBusy(false);
      return;
    }
    inFlight.current = false;
    await execute(p);
  }
  async function check(p: PendingJob) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/admin/jobs?requestId=${encodeURIComponent(p.requestId)}`,
        { cache: "no-store" },
      );
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      if (result.state === "CLOSED") {
        sessionStorage.removeItem(pendingKey);
        setPending(null);
        setStatus(
          "The pending request was safely closed. You may start another action.",
        );
      } else if (result.state === "COMPLETE") {
        sessionStorage.removeItem(pendingKey);
        setPending(null);
        await onChanged();
        setStatus(
          result.result.reconciliationRequired
            ? "Cancellation recorded; provider reconciliation is required and the reservation remains held."
            : `Job ${result.result.status}. Delivery remains unavailable in this local rehearsal.`,
        );
      } else
        setStatus(
          "The request is pending. Re-enter the original reason to resume the same request.",
        );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Unable to check the pending request.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function resolve(p: PendingJob) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/admin/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "resolve", requestId: p.requestId }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      if (result.state !== "CLOSED" && result.state !== "COMPLETE")
        throw Error("Request status remains unavailable.");
      sessionStorage.removeItem(pendingKey);
      setPending(null);
      await onChanged();
      setStatus(
        result.state === "CLOSED"
          ? "The pending request was safely closed. You may start another action."
          : result.result.reconciliationRequired
            ? "Cancellation recorded; provider reconciliation is required and the reservation remains held."
            : `Job ${result.result.status}. Delivery remains unavailable in this local rehearsal.`,
      );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `${error.message} The pending request remains saved.`
          : "Unable to resolve the request; it remains saved.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const enabled =
    ready && available && !blocked && permissions.includes("jobs:manage");
  return (
    <section aria-label="Staff operation controls">
      <p>
        {available
          ? "Local rehearsal only. A saved reservation and current sponsor proof are checked per action. Delivery remains unavailable."
          : "Staff retry, cancellation and recovery require current job permission and qualified provider-session proof. Uncertain provider acceptance requires reconciliation."}
      </p>
      <label htmlFor="staff-job-reason">Reason for operation action</label>
      <textarea
        id="staff-job-reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={500}
        style={{ width: "100%", maxWidth: "40rem" }}
      />
      <p role="status" aria-live="polite">
        {busy ? "Checking the operation…" : status}
      </p>
      {pending && (
        <section aria-label="Pending staff job request">
          <p>
            Request {pending.requestId} for operation {pending.target} may still
            be pending. The stored reference contains no session or step-up
            token.
          </p>
          <button
            type="button"
            disabled={busy || !enabled}
            onClick={() => void check(pending)}
          >
            Check request status
          </button>{" "}
          <button
            type="button"
            disabled={busy || !enabled || reason.trim().length < 12}
            onClick={() => void execute(pending)}
          >
            Resume with original reason
          </button>{" "}
          <p>
            Safe resolution waits for any running action. It returns a completed
            result or closes the uncommitted request so it cannot execute later.
          </p>
          <button
            type="button"
            disabled={busy || !enabled}
            onClick={() => void resolve(pending)}
          >
            Safely resolve pending request
          </button>
        </section>
      )}
      {rows.map((row) => (
        <div
          key={String(row.id)}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.5rem",
            marginBlock: "0.75rem",
          }}
        >
          <span>Operation {String(row.id)}</span>
          <button
            type="button"
            disabled={
              busy ||
              Boolean(pending) ||
              !enabled ||
              [
                "COMPLETED",
                "PARTIAL",
                "FAILED",
                "CANCELLED",
                "EXPIRED",
              ].includes(String(row.status))
            }
            onClick={() =>
              void start("jobs:cancel", String(row.id), Number(row.fence))
            }
          >
            Cancel operation
          </button>
          <button
            type="button"
            disabled={
              busy ||
              Boolean(pending) ||
              !enabled ||
              row.status !== "RUNNING" ||
              row.provider_attempt_state !== "NONE" ||
              typeof row.lease_until !== "string"
            }
            onClick={() =>
              void start("jobs:retry", String(row.id), Number(row.fence))
            }
          >
            Retry operation
          </button>
        </div>
      ))}
    </section>
  );
}
