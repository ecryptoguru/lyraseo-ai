import Link from "next/link";
export default function NotFound() {
  return (
    <main id="main" className="auth-page">
      <div className="auth-panel">
        <h1>That page isn’t here.</h1>
        <p>Return to your workspace to continue reviewing the evidence.</p>
        <Link href="/app" className="button button-primary">
          Open workspace
        </Link>
      </div>
    </main>
  );
}
