"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export function AcceptInvitation() {
  const router = useRouter();
  const [invitation, setInvitation] = useState<{
      workspaceId: string;
      invitationId: string;
      token: string;
    } | null>(null),
    [message, setMessage] = useState(
      "Prepare the private link, then sign in with the matching recipient account to accept.",
    ),
    [busy, setBusy] = useState(false);
  function prepare() {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const workspaceId = fragment.get("workspaceId"),
      invitationId = fragment.get("invitationId"),
      token = fragment.get("token");
    window.history.replaceState(null, "", window.location.pathname);
    if (workspaceId && invitationId && token) {
      setInvitation({ workspaceId, invitationId, token });
      setMessage(
        "Use the private pilot account matching the invitation recipient. No email will be sent.",
      );
    } else
      setMessage(
        "Invitation unavailable. Reopen the complete link supplied by your workspace manager.",
      );
  }
  async function accept() {
    if (!invitation) return;
    setBusy(true);
    try {
      const response = await fetch("/api/team/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invitation),
      });
      const value = await response.json();
      if (!response.ok) throw Error(value.error ?? "Invitation unavailable.");
      setInvitation(null);
      router.push(
        `/app/workspaces?workspace=${encodeURIComponent(value.workspaceId)}`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Invitation unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="pilot-card">
      <h2>Accept workspace access</h2>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {!invitation && (
        <button
          type="button"
          className="button button-secondary"
          onClick={prepare}
        >
          Prepare private invitation
        </button>
      )}
      {invitation && (
        <button
          type="button"
          className="button button-primary"
          disabled={busy}
          onClick={accept}
        >
          {busy ? "Accepting…" : "Accept this invitation"}
        </button>
      )}
      <a href="/sign-in">Sign in to your private pilot account</a>
    </section>
  );
}
