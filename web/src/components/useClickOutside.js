import { useEffect } from "react";

// Closes a popover when the user clicks elsewhere or presses Escape.
export default function useClickOutside(ref, onClose, active = true) {
  useEffect(() => {
    if (!active) return;

    const onPointer = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, onClose, active]);
}
