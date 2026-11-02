import type {
  PageDeclaration,
  ReadinessDeclarations,
} from "@lyraseo/visibility";

export const auditLines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
export function readAuditDeclarations(
  form: FormData,
  pages: string[],
): ReadinessDeclarations {
  const fields: ReadinessDeclarations = {};
  for (const key of ["brandName", "aboutUrl", "contactUrl"] as const) {
    const value = String(form.get(key) ?? "").trim();
    if (value) fields[key] = value;
  }
  for (const key of [
    "approvedAliases",
    "officialUrls",
    "requiredPolicyUrls",
  ] as const) {
    const values = auditLines(String(form.get(key) ?? ""));
    if (values.length) fields[key] = values;
  }
  const pageDeclarations = pages.flatMap((requestedUrl, i) => {
    const declaration: PageDeclaration = { requestedUrl };
    const intent = form.get("intent-" + i),
      kind = form.get("kind-" + i),
      canonical = String(form.get("canonical-" + i) ?? "").trim();
    if (intent === "indexable" || intent === "excluded")
      declaration.indexingIntent = intent;
    if (
      kind === "marketing" ||
      kind === "article" ||
      kind === "product" ||
      kind === "other"
    )
      declaration.pageType = kind;
    if (canonical) declaration.intendedCanonical = canonical;
    return Object.keys(declaration).length > 1 ? [declaration] : [];
  });
  if (pageDeclarations.length) fields.pageDeclarations = pageDeclarations;
  return fields;
}
export function AuditDeclarationsForm({
  pages,
  initial = {},
}: {
  pages: string[];
  initial?: ReadinessDeclarations;
}) {
  return (
    <details className="audit-declarations">
      <summary>Review optional audit declarations</summary>
      <p>
        These are your expectations for this run. Blank page fields remain
        undeclared. Blank identity fields use the latest reviewed business
        context.
      </p>
      <fieldset>
        <legend>Site identity and homepage links</legend>
        <label>
          Display brand
          <input
            className="audit-input"
            name="brandName"
            maxLength={512}
            defaultValue={initial.brandName}
          />
        </label>
        <label>
          Approved aliases, one per line
          <textarea
            className="audit-input"
            name="approvedAliases"
            defaultValue={initial.approvedAliases?.join("\n")}
          />
        </label>
        <label>
          Official organization URLs, one per line
          <textarea
            className="audit-input"
            name="officialUrls"
            defaultValue={initial.officialUrls?.join("\n")}
          />
        </label>
        <label>
          About page URL
          <input
            className="audit-input"
            name="aboutUrl"
            type="url"
            maxLength={2048}
            defaultValue={initial.aboutUrl}
          />
        </label>
        <label>
          Contact page URL
          <input
            className="audit-input"
            name="contactUrl"
            type="url"
            maxLength={2048}
            defaultValue={initial.contactUrl}
          />
        </label>
        <label>
          Required policy URLs, one per line
          <textarea
            className="audit-input"
            name="requiredPolicyUrls"
            defaultValue={initial.requiredPolicyUrls?.join("\n")}
          />
        </label>
      </fieldset>
      {pages.slice(0, 25).map((url, i) => {
        const d = initial.pageDeclarations?.find((p) => p.requestedUrl === url);
        return (
          <fieldset
            key={url + "-" + pages.slice(0, i).filter((p) => p === url).length}
          >
            <legend className="audit-url">{url}</legend>
            <label htmlFor={"audit-intent-" + i}>Intended indexing</label>
            <select
              id={"audit-intent-" + i}
              className="audit-input"
              name={"intent-" + i}
              defaultValue={d?.indexingIntent ?? ""}
            >
              <option value="">Undeclared</option>
              <option value="indexable">Intended to be indexed</option>
              <option value="excluded">Intentionally excluded</option>
            </select>
            <label htmlFor={"audit-kind-" + i}>Page type</label>
            <select
              id={"audit-kind-" + i}
              className="audit-input"
              name={"kind-" + i}
              defaultValue={d?.pageType ?? ""}
            >
              <option value="">Undeclared</option>
              {["marketing", "article", "product", "other"].map((kind) => (
                <option value={kind} key={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <label>
              Expected canonical URL
              <input
                className="audit-input"
                type="url"
                maxLength={2048}
                name={"canonical-" + i}
                defaultValue={d?.intendedCanonical}
              />
            </label>
          </fieldset>
        );
      })}
    </details>
  );
}
