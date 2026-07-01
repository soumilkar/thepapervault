import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";

export function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 400);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!visible) return null;

  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Scroll to top"
      className="fixed bottom-24 right-4 z-40 flex size-10 items-center justify-center rounded-full bg-primary/50 text-primary-foreground/90 shadow-md backdrop-blur-sm transition hover:bg-primary/80 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary/40 md:bottom-28 md:right-6"
    >
      <ArrowUp className="size-4" />
    </button>
  );
}
