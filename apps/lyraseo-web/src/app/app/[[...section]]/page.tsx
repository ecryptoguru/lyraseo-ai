import { cookies } from "next/headers";
import { authSettings } from "@/server/auth/settings";
import { redirect } from "next/navigation";
import { notFound } from "next/navigation";
import { Workspace } from "@/components/workspace";
const sections = [
  "overview",
  "sites",
  "audits",
  "issues",
  "content",
  "visibility",
  "search",
  "reports",
  "settings",
];
export default async function AppPage({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  if (authSettings()) redirect("/app/workspaces");
  const { section } = await params;
  const view = section?.[0] ?? "overview";
  if ((section?.length ?? 0) > 1 || !sections.includes(view)) notFound();
  const saved = (await cookies()).get("lyraseo-theme")?.value;
  return (
    <Workspace
      view={view}
      initialTheme={
        saved && ["light", "dark", "system"].includes(saved) ? saved : "system"
      }
    />
  );
}
