import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown } from "lucide-react";

/** The look of a hero's own call to action, so every caller's Link matches without the carousel
 * having to own the route it points at. */
export const HERO_ACTION_CLASS =
  "inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-bold text-zinc-900 transition-transform hover:scale-[1.02] active:scale-[0.98]";

const HERO_INTERVAL_MS = 7000;

/**
 * One slide, as the carousel needs it: display fields plus where the slide leads.
 *
 * Deliberately not an AnimeTitle. The home screen shows either a source's titles or an aggregator's
 * entries depending on a setting, and those are different things with different ids leading to
 * different routes - the one thing they have in common is exactly this shape.
 */
export interface HeroSlide {
  key: string;
  title: string;
  description?: string | null;
  posterUrl?: string | null;
  type?: string | null;
  year?: number | null;
  episodeCount?: number | null;
  /** The "open this" control, rendered by the caller so each keeps its own typed route and params -
   * a source title and an aggregator entry lead to different routes. Use HERO_ACTION_CLASS on it. */
  action: React.ReactNode;
}

export function HeroCarousel({ slides, label }: { slides: HeroSlide[]; label: string }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const slideKey = slides.map((slide) => slide.key).join(",");
  useEffect(() => { setIndex(0); }, [slideKey]);
  useEffect(() => {
    if (paused || slides.length <= 1) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % slides.length), HERO_INTERVAL_MS);
    return () => clearInterval(id);
  }, [paused, slides.length, slideKey]);
  const current = slides[Math.min(index, slides.length - 1)];
  if (!current) return null;
  return <div className="relative" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
    <AnimatePresence mode="wait">
      <motion.div key={current.key} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}>
        <Hero slide={current} label={label} />
      </motion.div>
    </AnimatePresence>
    {slides.length > 1 && <div className="absolute bottom-8 right-8 z-10 flex items-center gap-2">
      {slides.map((slide, i) => (
        <button
          key={slide.key}
          onClick={() => setIndex(i)}
          aria-label={`${i + 1}`}
          className={`h-1.5 rounded-full transition-[width,background-color] duration-300 ${i === index ? "w-6 bg-white" : "w-1.5 bg-white/30 hover:bg-white/50"}`}
        />
      ))}
    </div>}
  </div>;
}
function Hero({ slide, label }: { slide: HeroSlide; label: string }) {
  const { t } = useTranslation();
  const title = slide.title;
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const description = slide.description || t("catalog.heroFallbackDescription");
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const [collapsedHeight] = useState(72); // ~3 lines at text-sm/leading-6
  const [maxHeight, setMaxHeight] = useState(collapsedHeight);
  useEffect(() => {
    const full = descriptionRef.current?.scrollHeight ?? collapsedHeight;
    setMaxHeight(descriptionOpen ? full : Math.min(collapsedHeight, full));
  }, [descriptionOpen, description, collapsedHeight]);
  return <section className="relative isolate min-h-[420px] overflow-hidden border-b border-white/[.04] px-8 py-16">
    <div className="absolute inset-0 -z-10 overflow-hidden opacity-75">
      {slide.posterUrl && (
        <motion.img
          src={slide.posterUrl}
          alt=""
          initial={{ scale: 1 }}
          animate={{ scale: 1.1 }}
          transition={{ duration: HERO_INTERVAL_MS / 1000 + 1, ease: "linear" }}
          className="h-full w-full object-cover object-[center_25%] blur-[2px]"
        />
      )}
      <div className="absolute inset-0" style={{ backgroundImage: [
        "linear-gradient(180deg, #17161b 0px, transparent 64px)",
        "linear-gradient(90deg, rgba(23,22,27,.82) 0%, rgba(23,22,27,.54) 42%, rgba(23,22,27,.08) 100%)",
        "linear-gradient(0deg, #17161b 0px, rgba(23,22,27,.82) 48px, transparent 58%)",
      ].join(", ") }} />
    </div>
    <div className="max-w-2xl">
      <p className="mb-4 text-xs font-bold uppercase tracking-[.18em] text-accent-text">{label}</p>
      {/* The min-h wrapper reserves space for a full 2-line title regardless of how long this
          slide's title actually is - without it, switching from a 2-line to a 1-line title (or
          back) between carousel slides abruptly resizes this block and everything below it.
          min-height has to live on a wrapper, not the line-clamped element itself - combining
          -webkit-line-clamp with a min-height on the same element makes Chromium clip the text
          to nothing instead of just capping it at 2 lines. */}
      <div className="min-h-[2.1em]">
        <h1 className="line-clamp-2 max-w-xl select-text text-4xl font-bold leading-[1.05] tracking-[-.04em] text-white md:text-6xl">{title}</h1>
      </div>
      <div className="mt-5 max-w-lg overflow-hidden transition-[max-height] duration-300 ease-in-out" style={{ maxHeight }}>
        <p ref={descriptionRef} className="select-text text-sm leading-6 text-zinc-200">{description}</p>
      </div>
      {slide.description && <button onClick={() => setDescriptionOpen((value) => !value)} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-zinc-300 transition hover:text-white">{descriptionOpen ? t("common.hideDescription") : t("common.readDescription")}<ChevronDown className={`h-3.5 w-3.5 transition-transform duration-300 ${descriptionOpen ? "rotate-180" : ""}`} strokeWidth={2.5} /></button>}
      <div className="mt-5 flex items-center gap-3 text-xs font-medium text-zinc-200"><span className="rounded-md bg-white/15 px-2 py-1">{slide.type?.toUpperCase() || t("common.typeFallback")}</span>{slide.year && <span>{slide.year}</span>}{slide.episodeCount && <span>{t("common.episodesShort", { count: slide.episodeCount })}</span>}</div>
      <div className="mt-8">{slide.action}</div>
    </div>
  </section>;
}
