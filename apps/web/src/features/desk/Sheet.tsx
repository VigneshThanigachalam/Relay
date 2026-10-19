import { useEffect, useRef, type ReactNode } from 'react';
import { useNotificationTarget } from './feedback';
// Native modal dialogs own focus trapping, Escape and background inertness.
// Keep the opener explicitly: React may detach the dialog before effect cleanup,
// which prevents native close() from restoring focus reliably.
export function Sheet({
  label,
  close,
  children,
}: {
  label: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const target = useNotificationTarget();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.body.style.overflow;
    const opener = document.activeElement;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    target(dialog);
    return () => {
      target(null);
      dialog.close();
      document.body.style.overflow = previous;
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, [target]);
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="sheet-content">{children}</div>
    </dialog>
  );
}
