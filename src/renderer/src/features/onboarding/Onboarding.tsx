import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import appIcon from "@/assets/app-icon.png";
import { SourcesPage } from "@/routes/sources";
import { cn } from "@/lib/cn";

// Loosely mirrors the Android app's own first-launch flow, with one extra step in between -
// Android's onboarding never actually grew a source-picking step of its own (leftover, unused
// strings for one still sit in its resources), so this reuses the desktop app's real sources page
// outright rather than inventing a separate, parallel "pick a source" UI that would drift from the
// real one over time.
type Step = "welcome" | "sources";
const STEPS: Step[] = ["welcome", "sources"];

const slideVariants = {
  enter: (d: number) => ({ opacity: 0, x: d * 24 }),
  center: { opacity: 1, x: 0 },
  exit: (d: number) => ({ opacity: 0, x: d * -24 }),
};

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>("welcome");
  const [dir, setDir] = useState(1);
  const index = STEPS.indexOf(step);

  function goTo(next: Step) {
    setDir(STEPS.indexOf(next) > index ? 1 : -1);
    setStep(next);
  }

  return (
    <div className="flex h-full flex-col bg-app-bg">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-8 py-8">
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <motion.div
            key={step}
            custom={dir}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="flex h-full w-full items-center justify-center"
          >
            {step === "welcome" && <WelcomeStep onNext={() => goTo("sources")} />}
            {step === "sources" && <SourcesStep />}
          </motion.div>
        </AnimatePresence>
      </div>
      {step !== "welcome" && (
        <OnboardingFooter
          index={index}
          total={STEPS.length}
          onBack={() => goTo(STEPS[index - 1])}
          onNext={step === "sources" ? onComplete : () => goTo(STEPS[index + 1])}
          isLast={step === "sources"}
        />
      )}
    </div>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex max-w-sm flex-col items-center text-center">
      <div className="flex h-32 w-32 items-center justify-center overflow-hidden rounded-full bg-white shadow-2xl">
        <img src={appIcon} alt="" className="h-20 w-20 object-contain" />
      </div>
      <h1 className="mt-8 text-3xl font-bold text-text">{t("onboarding.welcome.title")}</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">{t("onboarding.welcome.description")}</p>
      <button onClick={onNext} className="mt-8 rounded-xl bg-accent px-6 py-3 text-sm font-bold text-accent-fg transition-opacity hover:opacity-90">
        {t("onboarding.getStarted")}
      </button>
    </div>
  );
}

function SourcesStep() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col">
      <div className="shrink-0 px-2 pb-4 text-center">
        <h1 className="text-2xl font-bold text-text">{t("onboarding.sources.title")}</h1>
        <p className="mt-2 text-sm text-muted">{t("onboarding.sources.description")}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-text/[.03]">
        <SourcesPage />
      </div>
    </div>
  );
}

function OnboardingFooter({
  index,
  total,
  onBack,
  onNext,
  isLast,
}: {
  index: number;
  total: number;
  onBack: () => void;
  onNext: () => void;
  isLast: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-20 shrink-0 items-center justify-between border-t border-border px-8">
      <button onClick={onBack} className="rounded-lg px-3 py-2 text-sm font-semibold text-muted transition-colors hover:bg-text/[.06] hover:text-text">
        {t("onboarding.back")}
      </button>
      <div className="flex items-center gap-1.5">
        {Array.from({ length: total }).map((_, i) => (
          <span key={i} className={cn("h-1.5 rounded-full transition-all duration-300", i === index ? "w-6 bg-accent" : "w-1.5 bg-text/[.15]")} />
        ))}
      </div>
      <button onClick={onNext} className="rounded-lg bg-accent px-4 py-2 text-sm font-bold text-accent-fg transition-opacity hover:opacity-90">
        {isLast ? t("onboarding.done") : t("onboarding.next")}
      </button>
    </div>
  );
}
