/**
 * Global motion wiring: Lenis smooth scroll synced to GSAP ScrollTrigger,
 * IntersectionObserver scroll-reveal, parallax, header state, scroll progress.
 *
 * Reduced-motion guard: if the user asks for less motion we skip Lenis, the
 * reveal arming, and every scrubbed effect. Content is fully visible without JS
 * (the `reveal-ready` class is the only thing that hides it, and it is added by
 * the inline head script only when motion is allowed).
 */
import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── header scrolled state + scroll progress (cheap, always on) ───────────────
const header = document.querySelector<HTMLElement>("[data-header]");
const progress = document.querySelector<HTMLElement>("[data-progress]");

function onScrollMeta(y: number) {
  header?.classList.toggle("is-scrolled", y > 36);
  if (progress) {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.transform = `scaleX(${max > 0 ? Math.min(y / max, 1) : 0})`;
  }
}

if (prefersReduced) {
  // no smooth scroll, no reveal arming. Just keep the header/progress honest.
  window.addEventListener("scroll", () => onScrollMeta(window.scrollY), { passive: true });
  onScrollMeta(window.scrollY);
} else {
  // ── scroll-reveal ──────────────────────────────────────────────────────────
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        const delay = el.dataset.revealDelay;
        if (delay) el.style.transitionDelay = `${delay}ms`;
        el.classList.add("is-in");
        io.unobserve(el);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
  );
  document.querySelectorAll("[data-reveal]").forEach((el) => io.observe(el));

  // ── Lenis smooth scroll, driven by the GSAP ticker ───────────────────────────
  const lenis = new Lenis({
    duration: 1.05,
    easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    smoothWheel: true,
  });

  lenis.on("scroll", ScrollTrigger.update);
  lenis.on("scroll", ({ scroll }: { scroll: number }) => onScrollMeta(scroll));
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
  onScrollMeta(0);

  // smooth anchor jumps with a header offset
  document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (ev) => {
      const href = a.getAttribute("href");
      if (!href || href.length < 2) return;
      const target = document.querySelector(href);
      if (!target) return;
      ev.preventDefault();
      lenis.scrollTo(target as HTMLElement, { offset: -84 });
      history.replaceState(null, "", href);
    });
  });

  // ── parallax: [data-parallax="0.2"] drifts at that fraction of scroll ────────
  gsap.utils.toArray<HTMLElement>("[data-parallax]").forEach((el) => {
    const speed = parseFloat(el.dataset.parallax || "0.15");
    gsap.fromTo(
      el,
      { yPercent: -speed * 50 },
      {
        yPercent: speed * 50,
        ease: "none",
        scrollTrigger: { trigger: el.parentElement || el, start: "top bottom", end: "bottom top", scrub: true },
      },
    );
  });

  // ── slow rotate / drift for ambient mesh blobs ──────────────────────────────
  gsap.utils.toArray<HTMLElement>("[data-drift]").forEach((el, i) => {
    gsap.to(el, {
      xPercent: i % 2 === 0 ? 8 : -8,
      yPercent: i % 2 === 0 ? -6 : 6,
      duration: 14 + i * 3,
      ease: "sine.inOut",
      repeat: -1,
      yoyo: true,
    });
  });

  // ── count-up for [data-countup] when it scrolls in ───────────────────────────
  gsap.utils.toArray<HTMLElement>("[data-countup]").forEach((el) => {
    const end = parseFloat(el.dataset.countup || "0");
    const suffix = el.dataset.countupSuffix || "";
    const obj = { v: 0 };
    ScrollTrigger.create({
      trigger: el,
      start: "top 85%",
      once: true,
      onEnter: () =>
        gsap.to(obj, {
          v: end,
          duration: 1.4,
          ease: "power2.out",
          onUpdate: () => {
            el.textContent = Math.round(obj.v).toLocaleString() + suffix;
          },
        }),
    });
  });

  // refresh once fonts settle so triggers measure the final layout
  if ("fonts" in document) {
    (document as any).fonts.ready.then(() => ScrollTrigger.refresh());
  }
}
