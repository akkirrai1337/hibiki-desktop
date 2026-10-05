import { createPortal } from "react-dom";
import { AnimatePresence, motion, useDragControls } from "motion/react";
import { usePopoverTheme } from "@/lib/usePopoverTheme";
import { useBackHandler } from "@/lib/mobile";
import { cn } from "@/lib/cn";

/**
 * The phone's menu and panel: rises from the bottom edge, where the thumb already is, over a scrim.
 * Closes by a tap on the scrim, by Back, or by pulling it down by its handle (or anywhere on its
 * header). Desktop keeps its own dropdowns and drawers; this is only used where `isMobile`.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  footer,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  /** Pinned under the scrolling body - actions such as Reset / Done. */
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const popoverTheme = usePopoverTheme();
  const drag = useDragControls();
  useBackHandler(open, onClose);

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[80]">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/55"
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 420, damping: 40 }}
            drag="y"
            dragListener={false}
            dragControls={drag}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 90 || info.velocity.y > 500) onClose();
            }}
            style={{ ...popoverTheme, paddingBottom: "var(--safe-bottom)" }}
            className={cn("absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-[1.5rem] border-t border-border bg-app-popover shadow-[0_-12px_40px_rgba(0,0,0,0.5)]", className)}
          >
            <div className="shrink-0 touch-none select-none pb-1 pt-2.5" onPointerDown={(event) => drag.start(event)}>
              <div className="mx-auto h-1 w-10 rounded-full bg-text/20" />
              {title && <div className="px-5 pb-1 pt-3 text-[15px] font-bold text-text">{title}</div>}
            </div>
            <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">{children}</div>
            {footer && <div className="shrink-0 border-t border-border px-4 py-3">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** One row of a sheet's list: a full-width tap target with an optional icon and trailing mark. */
export function SheetOption({ icon, label, detail, selected, danger, onClick }: { icon?: React.ReactNode; label: React.ReactNode; detail?: React.ReactNode; selected?: boolean; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-[3rem] w-full items-center gap-3.5 rounded-xl px-3.5 py-2.5 text-left text-[15px] transition-colors active:bg-text/[.08]",
        danger ? "text-rose-400" : "text-text",
        selected && "bg-text/[.06] font-semibold",
      )}
    >
      {icon && <span className={cn("flex shrink-0", danger ? "text-rose-400" : "text-muted")}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="line-clamp-1">{label}</span>
        {detail && <span className="mt-0.5 line-clamp-1 text-xs font-normal text-muted">{detail}</span>}
      </span>
      {selected && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
    </button>
  );
}
