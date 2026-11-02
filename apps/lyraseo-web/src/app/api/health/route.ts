import { NextResponse } from "next/server";
import { readConfig } from "@/server/config";
export function GET() {
  return NextResponse.json(
    { status: "local-fixtures", ...readConfig() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
