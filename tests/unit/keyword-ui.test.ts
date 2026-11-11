import { expect, it } from "vitest";
it("requires hydration and review before a keyword selection and distinguishes an unavailable quote", async () => {
  const React = await import("../../apps/lyraseo-web/node_modules/react");
  const { renderToStaticMarkup } =
    await import("../../apps/lyraseo-web/node_modules/react-dom/server");
  const { KeywordEnrichment } =
    await import("../../apps/lyraseo-web/src/components/keyword-enrichment");
  const html = renderToStaticMarkup(
    React.createElement(KeywordEnrichment, {
      workspaceId: "a",
      siteId: "site",
      editable: true,
      collectionEnabled: true,
      opportunities: [],
    }),
  );
  expect(html).toContain("Keyword enrichment");
  expect(html).toContain("No provider request");
  expect(html).toContain("disabled");
  expect(html).toContain("India");
});
