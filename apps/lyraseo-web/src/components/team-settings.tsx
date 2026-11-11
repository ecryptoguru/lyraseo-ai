"use client";
import { useState } from "react";
import { useClientReady } from "./use-client-ready";
import { TeamInvitations } from "./team-invitations";
type Member = {
  userId: string;
  role: "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";
  suspended: boolean;
  siteIds: string[];
};
export type Team = {
  accessRevision: number;
  members: Member[];
  sites: { id: string; origin: string }[];
  nextCursor: string | null;
  limit: number;
};
export function TeamSettings({
  workspaceId,
  initial,
  callerId,
}: {
  workspaceId: string;
  initial: Team;
  callerId: string;
}) {
  const ready = useClientReady(),
    [team, setTeam] = useState(initial),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("Current team access loaded."),
    [roles, setRoles] = useState<Record<string, Member["role"]>>({});
  async function request(input: Record<string, unknown>) {
    const response = await fetch("/api/team", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, ...input }),
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error ?? "Access change unavailable.");
    return value;
  }
  async function reload() {
    const response = await fetch(
      `/api/team?workspaceId=${encodeURIComponent(workspaceId)}`,
      { cache: "no-store" },
    );
    if (!response.ok)
      throw Error("Access changed. Refresh the page to continue.");
    setTeam(await response.json());
  }
  async function change(
    member: Member,
    action: "role" | "remove" | "grant" | "revoke",
    siteId?: string,
  ) {
    setBusy(true);
    try {
      let stepUpToken: string | undefined;
      const role = roles[member.userId] ?? member.role;
      if (
        (action === "role" || action === "remove") &&
        (member.role === "OWNER" || role === "OWNER")
      )
        stepUpToken = (await request({ action: "step-up" })).token;
      await request({
        action,
        userId: member.userId,
        expectedAccessRevision: team.accessRevision,
        ...(action === "role" ? { role } : {}),
        ...(siteId ? { siteId } : {}),
        ...(stepUpToken ? { stepUpToken } : {}),
      });
      await reload();
      setMessage(
        "Access updated. Removed grants stop saved evidence access immediately.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to save. Your selections are preserved.",
      );
      await reload().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function more() {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/team?workspaceId=${encodeURIComponent(workspaceId)}&cursor=${encodeURIComponent(team.nextCursor!)}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw Error("Team list unavailable.");
      const next: Team = await response.json();
      if (next.accessRevision !== team.accessRevision) {
        await reload();
        throw Error("Team changed. Review the refreshed list.");
      }
      setTeam({ ...next, members: [...team.members, ...next.members] });
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Team list unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section
        className="pilot-card agency-controls"
        aria-labelledby="team-heading"
      >
        <h2 id="team-heading">Team and site access</h2>
        <p>
          Members use their existing private pilot sign-in. Viewers can read and
          export only their granted sites. Editors can work on their granted
          sites. Owners and admins manage all sites in this workspace.
        </p>
        <p role="status" aria-live="polite">
          {message}
        </p>
        {!team.members.length ? (
          <p>No current members.</p>
        ) : (
          team.members.map((member) => (
            <fieldset key={member.userId} disabled={!ready || busy}>
              <legend>
                {member.userId}
                {member.userId === callerId ? " · you" : ""}
                {member.suspended ? " · suspended" : ""}
              </legend>
              <label>
                Workspace role
                <select
                  value={roles[member.userId] ?? member.role}
                  onChange={(e) =>
                    setRoles({
                      ...roles,
                      [member.userId]: e.target.value as Member["role"],
                    })
                  }
                >
                  {["OWNER", "ADMIN", "EDITOR", "VIEWER"].map((role) => (
                    <option key={role} value={role}>
                      {role.toLowerCase()}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => change(member, "role")}
              >
                Save role
              </button>
              <details>
                <summary>Granted sites for {member.userId}</summary>
                {team.sites.map((site) => (
                  <label key={site.id} style={{ display: "block" }}>
                    <input
                      type="checkbox"
                      checked={member.siteIds.includes(site.id)}
                      onChange={() =>
                        change(
                          member,
                          member.siteIds.includes(site.id) ? "revoke" : "grant",
                          site.id,
                        )
                      }
                    />
                    {site.origin}
                  </label>
                ))}
                {!team.sites.length && <p>No live sites in this workspace.</p>}
              </details>
              <details>
                <summary>Remove membership for {member.userId}</summary>
                <p>
                  This removes workspace and site access. Saved reports, history
                  and incurred charges remain attributable.
                </p>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => change(member, "remove")}
                >
                  Remove this member
                </button>
              </details>
            </fieldset>
          ))
        )}
        {team.nextCursor && (
          <button
            type="button"
            disabled={busy || !ready}
            className="button button-secondary"
            onClick={more}
          >
            Load more members
          </button>
        )}
      </section>
      <TeamInvitations
        workspaceId={workspaceId}
        revision={team.accessRevision}
        sites={team.sites}
        onChanged={reload}
      />
    </>
  );
}
