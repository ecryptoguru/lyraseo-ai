"use client";
import Link from "next/link";
export default function AppError({ retry }: { retry: () => void }) {
  return (
    <main id="main" className="pilot-page">
      <section className="pilot-card" aria-labelledby="error-heading">
        <h1 id="error-heading">Your workspace couldn’t load.</h1>
        <p>
          Please try again in a moment. If the problem continues, contact your
          pilot operator.
        </p>
        <button className="button button-primary" onClick={retry}>
          Try again
        </button>{" "}
        <Link className="button button-secondary" href="/">
          Back to home
        </Link>
      </section>
    </main>
  );
}
