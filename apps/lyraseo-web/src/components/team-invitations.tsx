"use client";
import { useEffect, useState } from "react";
import { useClientReady } from "./use-client-ready";
type Invitation = {
  id: string;
  role: string;
  expiresAt: string;
  sites: { siteId: string }[];
};
export function TeamInvitations({
  workspaceId,
  revision,
  sites,
  onChanged,
}: {
  workspaceId: string;
  revision: number;
  sites: { id: string; origin: string }[];
  onChanged: () => Promise<void>;
}) {
  const ready = useClientReady(),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("VIEWER"),
    [selection, setSelection] = useState<string[]>([]),
    [pending, setPending] = useState<Invitation[]>([]),
    [link, setLink] = useState(""),
    [message, setMessage] = useState(
      "Manual acceptance links expire after seven days. No email is sent.",
    ),
    [busy, setBusy] = useState(false);
  async function load() {
    const response = await fetch(
      `/api/team/invitations?workspaceId=${encodeURIComponent(workspaceId)}`,
      { cache: "no-store" },
    );
    if (response.ok) setPending(await response.json());
  }
  useEffect(() => {
    let active = true;
    fetch(
      `/api/team/invitations?workspaceId=${encodeURIComponent(workspaceId)}`,
      { cache: "no-store" },
    )
      .then(async (response) => (response.ok ? response.json() : []))
      .then((value) => {
        if (active) setPending(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [workspaceId, revision]);
  async function send(input: Record<string, unknown>) {
    setBusy(true);
    setLink("");
    try {
      const response = await fetch("/api/team/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          expectedAccessRevision: revision,
          ...input,
        }),
      });
      const value = await response.json();
      if (!response.ok)
        throw Error(
          value.error ?? "Invitation unavailable. Your entries are preserved.",
        );
      if (input.action === "invite") {
        const fragment = new URLSearchParams({
          workspaceId,
          invitationId: value.id,
          token: value.token,
        });
        setLink(`${window.location.origin}/app/team/accept#${fragment}`);
        setMessage(
          "Copy this private link now. It is shown once; share it only with the intended recipient using your own channel.",
        );
      } else setMessage("Invitation revoked.");
      await onChanged();
      await load();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Invitation unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="pilot-card agency-controls"
      aria-labelledby="invitation-heading"
    >
      <h2 id="invitation-heading">Manual team invitations</h2>
      <p>
        Recipients must already be admitted to the private pilot and sign in
        with the matching verified email. This does not create a provider
        account or send a message.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send({ action: "invite", email, role, siteIds: selection });
        }}
      >
        <fieldset disabled={!ready || busy}>
          <legend>Create a seven-day acceptance link</legend>
          <label htmlFor="invite-email">Recipient email</label>
          <input
            id="invite-email"
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label htmlFor="invite-role">Role</label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="VIEWER">Viewer/client · read and export</option>
            <option value="EDITOR">Editor · work on granted sites</option>
          </select>
          <fieldset>
            <legend>Explicit site grants</legend>
            {sites.map((site) => (
              <label style={{ display: "block" }} key={site.id}>
                <input
                  type="checkbox"
                  checked={selection.includes(site.id)}
                  onChange={() =>
                    setSelection((previous) =>
                      previous.includes(site.id)
                        ? previous.filter((id) => id !== site.id)
                        : [...previous, site.id],
                    )
                  }
                />
                {site.origin}
              </label>
            ))}
          </fieldset>
          <button className="button button-secondary">
            Create acceptance link
          </button>
        </fieldset>
      </form>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {link && (
        <label>
          One-time private link
          <textarea
            readOnly
            rows={4}
            value={link}
            onFocus={(e) => e.target.select()}
          />
        </label>
      )}
      <h3>Pending links</h3>
      {!pending.length ? (
        <p>No active pending invitations.</p>
      ) : (
        <ul>
          {pending.map((invitation) => (
            <li key={invitation.id}>
              {invitation.id} · {invitation.role.toLowerCase()} · expires{" "}
              {invitation.expiresAt.slice(0, 10)} · {invitation.sites.length}{" "}
              sites{" "}
              <button
                type="button"
                disabled={busy || !ready}
                onClick={() =>
                  send({ action: "revoke", invitationId: invitation.id })
                }
              >
                Revoke this link
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
