"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useId, useRef, useState } from "react";

export type ConfirmOptions = { title: string; description: string; confirmLabel?: string };
type ConfirmAction = (options: ConfirmOptions) => Promise<boolean>;
type PendingConfirmation = ConfirmOptions & { id: number; resolve: (accepted: boolean) => void };

const ConfirmContext = createContext<ConfirmAction | null>(null);

export function useConfirmAction() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("Confirmation actions must be rendered inside ConfirmProvider.");
  return confirm;
}

export default function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const pendingRef = useRef<PendingConfirmation | null>(null);
  const nextId = useRef(0);
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const confirm = useCallback<ConfirmAction>((options) => new Promise(resolve => {
    pendingRef.current?.resolve(false);
    const request = { ...options, id: ++nextId.current, resolve };
    pendingRef.current = request;
    setPending(request);
  }), []);

  const settle = useCallback((accepted: boolean) => {
    const request = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    request?.resolve(accepted);
  }, []);

  useEffect(() => {
    if (!pending) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        settle(false);
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [pending, settle]);

  return <ConfirmContext.Provider value={confirm}>
    {children}
    {pending && <div className="confirm-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) settle(false); }}>
      <section ref={dialogRef} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
        <h2 id={titleId}>{pending.title}</h2>
        <p id={descriptionId}>{pending.description}</p>
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} type="button" className="confirm-dialog-cancel" onClick={() => settle(false)}>Cancel</button>
          <button type="button" className="confirm-dialog-danger" onClick={() => settle(true)}>{pending.confirmLabel || "Delete"}</button>
        </div>
      </section>
    </div>}
  </ConfirmContext.Provider>;
}
