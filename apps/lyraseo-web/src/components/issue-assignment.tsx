"use client";
import { useEffect, useRef, useState } from "react";
import { useClientReady } from "./use-client-ready";
type SavedAssignment = { assigneeUserId: string | null; revision: number };
function savedAssignment(value: unknown): SavedAssignment | null {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== "object" ||
    !("revision" in value) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !("assigneeUserId" in value) ||
    (value.assigneeUserId !== null && typeof value.assigneeUserId !== "string")
  )
    throw Error("Assignment response unavailable.");
  return {
    revision: Number(value.revision),
    assigneeUserId: value.assigneeUserId as string | null,
  };
}
async function readExact(query: string) {
  const response = await fetch(`/api/assignments?${query}`, {
    cache: "no-store",
  });
  if (!response.ok)
    throw Error("Assignment unavailable. Refresh when access is restored.");
  return savedAssignment(await response.json());
}
export function IssueAssignment({
  workspaceId,
  siteId,
  auditId,
  ruleId,
  scopeKey,
  assignees,
}: {
  workspaceId: string;
  siteId: string;
  auditId: string;
  ruleId: string;
  scopeKey: string;
  assignees: { userId: string; role: string }[];
}) {
  const ready = useClientReady(),
    [current, setCurrent] = useState<SavedAssignment | null>(null),
    [loadedQuery, setLoadedQuery] = useState<string | null>(null),
    [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [recovery, setRecovery] = useState<"conflict" | "uncertain" | null>(null),
    [message, setMessage] = useState("Loading saved issue assignment…");
  const pending = useRef<{
    workspaceId: string;
    siteId: string;
    auditId: string;
    ruleId: string;
    scopeKey: string;
    assigneeUserId: string | null;
    expectedRevision: number;
    idempotencyKey: string;
  } | null>(null);
  const query = new URLSearchParams({
      workspaceId,
      siteId,
      auditId,
      ruleId,
      scopeKey,
    }).toString(),
    loaded = loadedQuery === query;
  useEffect(() => {
    let active = true;
    readExact(query)
      .then((row) => {
        if (!active) return;
        setCurrent(row);
        setSelected(row?.assigneeUserId ?? "");
        setLoadedQuery(query);
        pending.current = null;
        setRecovery(null);
        setMessage(
          row?.assigneeUserId
            ? `Assigned to ${row.assigneeUserId}`
            : "Issue is unassigned.",
        );
      })
      .catch((error) => {
        if (active) setMessage(error.message);
      });
    return () => {
      active = false;
    };
  }, [query]);
  async function refresh() {
    setBusy(true);
    try {
      const row = await readExact(query);
      setCurrent(row);
      setLoadedQuery(query);
      pending.current = null;
      setRecovery(null);
      setMessage(
        `Latest saved assignment loaded: ${row?.assigneeUserId ?? "unassigned"}, revision ${row?.revision ?? 0}. Your proposed selection is preserved. Review it before saving.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Assignment unavailable. Your proposed selection is preserved.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!loaded || recovery === "conflict") return;
    pending.current ??= {
      workspaceId,
      siteId,
      auditId,
      ruleId,
      scopeKey,
      assigneeUserId: selected || null,
      expectedRevision: current?.revision ?? 0,
      idempotencyKey: crypto.randomUUID(),
    };
    setBusy(true);
    try {
      const response = await fetch("/api/assignments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(pending.current),
        }),
        value = await response.json();
      if (response.status === 409) {
        setRecovery("conflict");
        setMessage(
          `${typeof value.error === "string" ? value.error : "Assignment changed."} Refresh and review the saved assignment before retrying. Your proposed selection is preserved.`,
        );
        return;
      }
      if (!response.ok)
        throw Error(
          typeof value.error === "string"
            ? value.error
            : "Assignment unavailable.",
        );
      const row = savedAssignment(value);
      if (!row) throw Error("Assignment acknowledgement unavailable.");
      pending.current = null;
      setCurrent(row);
      setSelected(row.assigneeUserId ?? "");
      setLoadedQuery(query);
      setRecovery(null);
      setMessage(
        `Issue assignment saved. The finding and measured outcome are unchanged. Last saved assignee: ${row.assigneeUserId ?? "unassigned"}, revision ${row.revision}.`,
      );
    } catch (error) {
      setRecovery("uncertain");
      setMessage(
        `${error instanceof Error ? error.message : "Assignment response unavailable."} The result is unconfirmed. Retry the saved command or refresh and review; your proposed selection is preserved.`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="agency-controls"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        Issue assignee
        <select
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={!ready || busy || !loaded || recovery === "uncertain"}
        >
          <option value="">Unassigned</option>
          {assignees.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.userId} · {member.role.toLowerCase()}
            </option>
          ))}
        </select>
      </label>
      {loaded && (
        <p>
          Last loaded assignment: {current?.assigneeUserId ?? "unassigned"} ·
          revision {current?.revision ?? 0}
        </p>
      )}
      <button
        className="button button-secondary"
        disabled={!ready || busy || !loaded || recovery === "conflict"}
      >
        {recovery === "uncertain"
          ? "Retry saved assignment"
          : "Save issue assignment"}
      </button>
      {(recovery || !loaded) && (
        <button
          type="button"
          className="button button-secondary"
          disabled={!ready || busy}
          onClick={refresh}
        >
          Refresh assignment and review changes
        </button>
      )}
      <p role="status" aria-live="polite">
        {message}
      </p>
    </form>
  );
}
