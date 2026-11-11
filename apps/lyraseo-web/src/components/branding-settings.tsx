"use client";
import { useState } from "react";
import { useClientReady } from "./use-client-ready";
type Brand = {
  revision: number;
  displayName: string;
  logoSha256: string | null;
};
export function BrandingSettings({
  workspaceId,
  initial,
  siteId,
}: {
  workspaceId: string;
  initial: Brand | null;
  siteId?: string;
}) {
  const ready = useClientReady(),
    [current, setCurrent] = useState(initial),
    [name, setName] = useState(initial?.displayName ?? ""),
    [logo, setLogo] = useState<File | null>(null),
    [clear, setClear] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(
      "Branding applies only when a new report explicitly selects its revision. Saved reports keep their captured presentation.",
    );
  async function save() {
    setBusy(true);
    try {
      const form = new FormData();
      form.set("workspaceId", workspaceId);
      form.set("expectedRevision", String(current?.revision ?? 0));
      form.set("displayName", name);
      if (logo) form.set("logo", logo);
      if (clear) form.set("clearLogo", "true");
      const response = await fetch("/api/branding", {
        method: "POST",
        body: form,
      });
      const value = await response.json();
      if (!response.ok) {
        if (response.status === 409) {
          const latest = await fetch(
            `/api/branding?workspaceId=${encodeURIComponent(workspaceId)}`,
            { cache: "no-store" },
          );
          if (latest.ok) setCurrent(await latest.json());
        }
        throw Error(
          value.error ??
            "Branding unavailable. Your current branding and entries are preserved.",
        );
      }
      setCurrent(value);
      setLogo(null);
      setClear(false);
      setMessage(
        `Branding revision ${value.revision} saved. Select this revision when creating a new private report.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Branding unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="pilot-card agency-controls"
      aria-labelledby="branding-heading"
    >
      <h2 id="branding-heading">Private report branding</h2>
      <p>
        Optional workspace name and raster logo. LyraSEO evidence sources,
        dates, coverage and limitations stay visible.
      </p>
      {current && <p>Current branding revision: {current.revision}</p>}
      {current?.logoSha256 && siteId && (
        <img
          src={`/api/branding/logo?workspaceId=${encodeURIComponent(workspaceId)}&siteId=${encodeURIComponent(siteId)}&revision=${current.revision}`}
          alt={`${current.displayName || "Workspace"} report logo`}
          width={256}
          style={{ maxWidth: "100%", height: "auto" }}
        />
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={!ready || busy}>
          <legend>New branding revision</legend>
          <label htmlFor="brand-name">Display name</label>
          <input
            id="brand-name"
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
          />
          <label htmlFor="brand-logo">Logo · PNG/JPEG, up to 512 KiB</label>
          <input
            id="brand-logo"
            type="file"
            accept="image/png,image/jpeg"
            onChange={(event) => {
              setLogo(event.target.files?.[0] ?? null);
              setClear(false);
            }}
          />
          <p>
            Images are sanitized into a private PNG, at most 512 × 256 pixels.
            Animated, malformed and oversized images are rejected.
          </p>
          <label>
            <input
              type="checkbox"
              checked={clear}
              onChange={(event) => {
                setClear(event.target.checked);
                if (event.target.checked) setLogo(null);
              }}
            />
            Remove the logo in this new revision
          </label>
          <button className="button button-secondary">
            Save branding revision
          </button>
        </fieldset>
      </form>
      <p role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}
