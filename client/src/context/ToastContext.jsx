import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

const ToastContext = createContext(null);
let idCounter = 0;

/**
 * Global toast queue. Mounted once in App.jsx; any future portal calls
 * useToast() to push a non-disruptive notification (success/error/info)
 * without needing to know where the viewport renders.
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (message, { variant = "info", duration = 5000, title } = {}) => {
      const id = ++idCounter;
      setToasts((current) => [...current, { id, message, variant, title }]);
      if (duration > 0) {
        const handle = setTimeout(() => dismiss(id), duration);
        timers.current.set(id, handle);
      }
      return id;
    },
    [dismiss]
  );

  const api = useMemo(
    () => ({
      toasts,
      dismiss,
      show: push,
      success: (message, opts) => push(message, { ...opts, variant: "success" }),
      error: (message, opts) => push(message, { ...opts, variant: "danger" }),
      info: (message, opts) => push(message, { ...opts, variant: "info" }),
      warning: (message, opts) => push(message, { ...opts, variant: "warning" }),
    }),
    [toasts, dismiss, push]
  );

  return <ToastContext.Provider value={api}>{children}</ToastContext.Provider>;
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
