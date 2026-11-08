import type { Metadata } from "next";
import { AcceptInvitation } from "@/components/accept-invitation";
export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};
export default function AcceptPage() {
  return (
    <main id="main" className="pilot-page">
      <header className="pilot-title">
        <h1>Private workspace invitation</h1>
      </header>
      <AcceptInvitation />
    </main>
  );
}
