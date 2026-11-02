import Link from "next/link";
import {
  ArrowUpRight,
  ArrowRight,
  Check,
  Search,
  ScanLine,
  ChartNoAxesCombined,
  Link2,
  MoveRight,
} from "lucide-react";
export default function Home() {
  return (
    <div className="marketing">
      <header className="marketing-nav">
        <Link href="/" aria-label="LyraSEO AI home">
          <img
            src="/brand/logo-white.svg"
            width="194"
            height="38"
            alt="LyraSEO AI"
          />
        </Link>
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#visibility">AI visibility</a>
          <Link className="nav-cta" href="/sign-in">
            Private pilot <ArrowUpRight size={16} />
          </Link>
        </nav>
      </header>
      <main id="main">
        <section className="hero">
          <div className="hero-copy">
            <h1>
              A clearer view.
              <br />A better next move.
            </h1>
            <p>
              See what’s holding your website back.
              <br className="desktop-break" /> Turn the evidence into
              improvements that matter.
            </p>
            <div className="hero-actions">
              <Link className="button button-white" href="/app/audits">
                Explore the sample audit <ArrowUpRight size={19} />
              </Link>
              <a className="hero-link" href="#how-it-works">
                See how it works <ArrowRight size={17} />
              </a>
            </div>
            <span className="hero-note">
              Private pilot · Local demonstration · No account needed for the
              sample
            </span>
          </div>
          <div className="hero-review" aria-label="Illustrative audit finding">
            <div className="review-top">
              <span>
                <img
                  src="/brand/symbol-light.svg"
                  width="23"
                  height="23"
                  alt=""
                />{" "}
                Launch review
              </span>
              <span className="pill neutral">Illustrative example</span>
            </div>
            <div className="review-domain">
              <ScanLine size={18} /> example.com <span>/ product</span>
            </div>
            <div className="hero-finding">
              <span className="pill danger">Title needs attention</span>
              <h2>
                A small detail.
                <br />A clearer first impression.
              </h2>
              <p>
                The page title is empty. Give people a useful description of
                what they’ll find.
              </p>
              <div className="code-line">&lt;title&gt;&lt;/title&gt;</div>
              <div className="review-action">
                <span className="icon-well">
                  <Check size={20} />
                </span>
                <div>
                  <strong>Write a descriptive title</strong>
                  <small>Then publish, rerun and compare.</small>
                </div>
                <ArrowUpRight size={20} />
              </div>
            </div>
            <div className="review-foot">
              Evidence first. Useful action next.<span>01 / 03</span>
            </div>
          </div>
        </section>
        <section className="workflow" id="how-it-works">
          <div className="section-heading">
            <h2>
              From “what’s wrong?”
              <br />
              to “here’s what’s next.”
            </h2>
            <p>
              A practical review of your public website, with the context to
              make a confident change.
            </p>
          </div>
          <div className="workflow-steps">
            <article>
              <Search size={25} />
              <h3>Understand the evidence</h3>
              <p>
                Review indexing, page structure and explicit identity signals
                across a bounded set of pages.
              </p>
            </article>
            <MoveRight className="step-arrow" />
            <article>
              <ScanLine size={25} />
              <h3>Make the useful fixes</h3>
              <p>
                See the observed issue, its source and a clear next action. Keep
                control of every published change.
              </p>
            </article>
            <MoveRight className="step-arrow" />
            <article>
              <ChartNoAxesCombined size={25} />
              <h3>Compare what changed</h3>
              <p>
                Rerun the same scope. Separate confirmed improvements from
                missing or incomparable evidence.
              </p>
            </article>
          </div>
        </section>
        <section className="visibility-story" id="visibility">
          <div>
            <h2>
              Website readiness.
              <br />
              Observed AI visibility.
              <br />
              <span>Both, in perspective.</span>
            </h2>
            <p>
              A technically ready page and an AI recommendation tell different
              stories. LyraSEO AI keeps them clear, with sources, dates and
              sample sizes beside the results.
            </p>
            <Link className="text-link" href="/app/visibility">
              Explore the visibility workspace <ArrowUpRight size={18} />
            </Link>
          </div>
          <div className="evidence-ledger">
            <div>
              <ScanLine size={20} />
              <strong>Readiness audit</strong>
              <span>Deterministic checks</span>
            </div>
            <div>
              <Link2 size={20} />
              <strong>AI observations</strong>
              <span>API and consumer surfaces</span>
            </div>
            <div>
              <ChartNoAxesCombined size={20} />
              <strong>Search performance</strong>
              <span>Google Search Console</span>
            </div>
            <p>Separate evidence. One considered workspace.</p>
          </div>
        </section>
        <section className="closing">
          <h2>
            Your next improvement
            <br />
            starts with a closer look.
          </h2>
          <Link className="button button-primary" href="/app/audits">
            Open the sample workspace <ArrowUpRight size={18} />
          </Link>
          <p>Local synthetic examples. Live providers are not connected.</p>
        </section>
      </main>
      <footer className="marketing-footer">
        <img
          src="/brand/logo-light.svg"
          width="155"
          height="30"
          alt="LyraSEO AI"
        />
        <span>Search readiness. Evidence. Action.</span>
        <span>Private pilot · 2026</span>
      </footer>
    </div>
  );
}
