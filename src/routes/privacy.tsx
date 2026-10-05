import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { title: "Privacy Policy — The PaperVault" },
      { name: "description", content: "Privacy Policy for The PaperVault." },
      { property: "og:title", content: "Privacy Policy — The PaperVault" },
      { property: "og:description", content: "Privacy Policy for The PaperVault." },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
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
            This page is maintained by The PaperVault to explain how we handle your data.
          </p>
          <h1 className="mt-2 font-serif text-4xl text-primary">Privacy Policy</h1>
          <p className="mt-4 text-sm text-muted-foreground">Last updated: June 19, 2026</p>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">1. What We Collect</h2>
            <p>
              We collect information you provide when creating an account, writing diary entries, publishing blog posts, uploading gallery photos, or interacting with the AI companion. This may include your email address, display name, written content, images, and usage preferences.
            </p>
            <p>
              We also collect basic technical information needed to run the service, such as your browser type, device information, and IP address, through standard hosting and analytics tools.
            </p>
          </section>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">2. How We Use Your Information</h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>To provide and maintain your personal journal, blog, gallery, and AI companion.</li>
              <li>To display public content you choose to share with the community.</li>
              <li>To send optional email notifications, such as when someone comments on your blog post.</li>
              <li>To improve the service and fix issues.</li>
            </ul>
          </section>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">3. Sharing Your Information</h2>
            <p>
              We do not sell your personal information. We share data only with trusted service providers needed to operate the app (such as hosting and authentication services), and only when required by law.
            </p>
            <p>
              Content you mark as public may be visible to other users and visitors. Private diary entries and personal content remain visible only to you and the AI companion features you choose to use.
            </p>
          </section>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">4. Data Storage and Security</h2>
            <p>
              Your data is stored securely with industry-standard protections. However, no online service is completely secure. Please use a strong password and keep your login credentials safe.
            </p>
          </section>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">5. Your Choices</h2>
            <p>
              You can edit or delete your content at any time. You can choose whether diary entries and blog posts are private or public. You can also turn off comment notifications when publishing a blog post.
            </p>
          </section>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">6. Cookies and Analytics</h2>
            <p>
              We use essential cookies to keep you signed in and may use basic analytics to understand how the service is used. You can control cookies through your browser settings.
            </p>
          </section>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">7. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy as the service evolves. We will revise the "Last updated" date when changes are made.
            </p>
          </section>

          <section className="mt-8 space-y-4 text-foreground/90">
            <h2 className="font-serif text-2xl text-primary">8. Contact</h2>
            <p>
              For privacy questions or data requests, contact us at{" "}
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
