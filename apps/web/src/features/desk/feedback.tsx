import { createPortal } from 'react-dom';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './Icon';
type Notice = { title: string; description?: string; type?: 'success' | 'error' | 'info' };
const NotificationTargetContext = createContext<(node: HTMLElement | null) => void>(() => {});
export const useNotificationTarget = () => useContext(NotificationTargetContext);
const NotifyContext = createContext<(notice: Notice) => void>(() => {});
export const useNotify = () => useContext(NotifyContext);
function Toast({ notice, dismiss }: { notice: Notice & { id: number }; dismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(dismiss, 8000);
    return () => clearTimeout(timer);
  }, [dismiss]);
  return (
    <div
      className={`toast ${notice.type ?? 'success'}`}
      role={notice.type === 'error' ? 'alert' : 'status'}
    >
      <span className="toast-icon">
        <Icon
          name={notice.type === 'error' ? 'alert' : notice.type === 'info' ? 'refresh' : 'check'}
        />
      </span>
      <div>
        <strong>{notice.title}</strong>
        {notice.description && <p>{notice.description}</p>}
      </div>
      <button className="icon-button" aria-label={`Dismiss ${notice.title}`} onClick={dismiss}>
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}
export function Notifications({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<(Notice & { id: number })[]>([]);
  const sequence = useRef(0);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const notify = useCallback(
    (notice: Notice) =>
      setItems((old) => [...old.slice(-2), { ...notice, id: ++sequence.current }]),
    [],
  );
  return (
    <NotifyContext.Provider value={notify}>
      <NotificationTargetContext.Provider value={setTarget}>
        {children}
        {createPortal(
          <div className="toast-stack" aria-label="Notifications">
            {items.map((item) => (
              <Toast
                key={item.id}
                notice={item}
                dismiss={() => setItems((old) => old.filter((n) => n.id !== item.id))}
              />
            ))}
          </div>,
          target ?? document.body,
        )}
      </NotificationTargetContext.Provider>
    </NotifyContext.Provider>
  );
}
