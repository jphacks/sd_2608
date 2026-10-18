import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** 閉じる間も直前の内容を残し、縮小が終わってから非表示にする。 */
export function AnimatedBubble({ open, reduced, wide, label, children }: {
  open: boolean; reduced: boolean; wide: boolean; label: string; children: ReactNode;
}) {
  const [phase, setPhase] = useState<"open" | "closing" | "closed">(open ? "open" : "closed");
  const lastContent = useRef(children);
  const lastWide = useRef(wide);
  useLayoutEffect(() => {
    if (open) { lastContent.current = children; lastWide.current = wide; }
  }, [open, children, wide]);
  useLayoutEffect(() => {
    setPhase(current => open ? "open" : reduced || current === "closed" ? "closed" : "closing");
  }, [open, reduced]);
  useEffect(() => {
    if (phase !== "closing") return;
    // animationend が届かない場合にも操作不能な吹き出しを残さない。
    const timer = setTimeout(() => setPhase("closed"), 160);
    return () => clearTimeout(timer);
  }, [phase]);
  return <div className={`bub${(open ? wide : lastWide.current) ? " wide" : ""}`} data-state={phase}
    data-pochi-hit={open ? "" : undefined} role="dialog" aria-label={label} aria-live="polite"
    aria-hidden={!open} inert={!open} hidden={phase === "closed"}
    onAnimationEnd={event => {
      if (event.target === event.currentTarget && event.animationName === "pochi-hide" && !open) setPhase("closed");
    }}>
    {open ? children : lastContent.current}
  </div>;
}
