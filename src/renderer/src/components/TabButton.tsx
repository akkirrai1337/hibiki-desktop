import { motion } from "motion/react";
import { cn } from "@/lib/cn";

export function TabButton({ active, onClick, layoutId, children }: { active: boolean; onClick: () => void; layoutId: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative px-4 py-2.5 text-sm font-semibold transition-colors duration-200",
        active ? "text-text" : "text-muted hover:text-text/80",
      )}
    >
      {children}
      {active && (
        <motion.span
          layoutId={layoutId}
          className="absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-accent"
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
        />
      )}
    </button>
  );
}
