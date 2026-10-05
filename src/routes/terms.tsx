import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { title: "Terms of Service — The PaperVault" },
      { name: "description", content: "Terms of Service for The PaperVault." },
      { property: "og:title", content: "Terms of Service — The PaperVault" },
      { property: "og:description", content: "Terms of Service for The PaperVault." },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Link to="/" className="flex items-center gap-2">
          <span className="font-serif text-2xl text-primary">The PaperVault</span>
          <span className="font-hand text-sepia text-lg">·your story</span>
        </Link>
        <Link to="/app" className="text-sm text-primary hover:underline">
          Open app
        </Link>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <article className="paper-card p-8 sm:p-10">
          <p className="text-sm text-muted-foreground">
            This page is maintained by The PaperVault to answer common questions about using the service.
          </p>
          <h1 className="mt-2 font-serif text-4xl text-primary">Terms of Service</h1>
          <p className="mt-4 text-sm text-muted-foreground">Last updated: June 19, 2026</p>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">1. Acceptance of Terms</h2>
            <p>
              By accessing or using The PaperVault, you agree to these Terms of Service. If you do not agree, please do not use the service.
            </p>
          </section>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">2. Your Account</h2>
            <p>
              You are responsible for keeping your account credentials secure. You must be at least 13 years old to use The PaperVault. Notify us immediately if you suspect unauthorized access to your account.
            </p>
          </section>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">3. User Content</h2>
            <p>
              You retain ownership of the diary entries, blog posts, photos, and other content you create. You grant The PaperVault a limited license to host, store, and display your content solely to operate the service for you.
            </p>
            <p>
              Do not post content that violates the law, infringes on others' rights, or is harmful, abusive, or spam. Public blog posts and public diary entries are visible to others, so only share content you are comfortable making public.
            </p>
          </section>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">4. Acceptable Use</h2>
            <p>
              You agree not to misuse the service, including attempting to access other users' accounts, uploading malicious files, scraping content, or overloading our systems.
            </p>
          </section>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">5. Termination</h2>
            <p>
              We may suspend or terminate your account if you violate these terms. You may delete your account at any time. Upon termination, your content may be deleted according to our data practices.
            </p>
          </section>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">6. Disclaimers</h2>
            <p>
              The PaperVault is provided "as is" without warranties of any kind. The AI companion is a reflection tool and does not provide professional advice. We are not liable for any indirect or consequential damages arising from your use of the service.
            </p>
          </section>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">7. Changes to These Terms</h2>
            <p>
              We may update these terms from time to time. Continued use of the service after changes means you accept the revised terms.
            </p>
          </section>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">8. Contact</h2>
            <p>
              Questions about these terms can be sent to{" "}
              <a href="mailto:soumil.karma@gmail.com" className="text-primary underline-offset-2 hover:underline">
                soumil.karma@gmail.com
              </a>
              .
            </p>
          </section>
        </article>
      </main>

      <footer className="border-t border-border/60 bg-card/40">
        <div className="mx-auto max-w-6xl px-4 py-8 text-center sm:px-6">
          <div className="flex flex-wrap justify-center gap-4 text-sm text-muted-foreground">
            <Link to="/" className="hover:text-primary">Home</Link>
            <Link to="/privacy" className="hover:text-primary">Privacy Policy</Link>
            <Link to="/terms" className="hover:text-primary">Terms of Service</Link>
          </div>
          <p className="mt-4 font-hand text-lg text-sepia">The PaperVault · your story</p>
        </div>
      </footer>
    </div>
  );
}
