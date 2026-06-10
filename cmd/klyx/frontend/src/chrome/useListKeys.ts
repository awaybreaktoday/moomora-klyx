import { useEffect } from "react";
import { getPaletteOpen } from "./CommandPalette";

/**
 * useListKeys — keyboard navigation for triage list views.
 *
 * Installs a window keydown listener while the owning view is mounted.
 * Only one view is ever mounted at a time per section, so there is no
 * listener stacking concern.
 *
 * Keys:
 *   j / ArrowDown  → select next (clamp at end)
 *   k / ArrowUp    → select prev (clamp at 0)
 *   Enter          → onActivate(selected)
 *   Escape         → onEscape()
 *   /              → preventDefault + focus searchRef
 *   <extraKeys>    → caller-supplied single-character handlers (same guards apply)
 *
 * Guards (all suppress the key):
 *   - event.target is INPUT, TEXTAREA, or contentEditable
 *   - paletteOpen flag is true
 *   - event has meta / ctrl / alt modifier
 */

export interface UseListKeysOptions {
  /** Total number of items in the rendered list */
  count: number;
  /** Currently selected index (-1 = none) */
  selected: number;
  /** Called when selection changes */
  onSelect: (idx: number) => void;
  /** Called when Enter is pressed on a selected item */
  onActivate: (idx: number) => void;
  /** Called on Escape (optional) */
  onEscape?: () => void;
  /** Ref to the search/filter input to focus on "/" */
  searchRef?: React.RefObject<HTMLInputElement | null>;
  /**
   * Extra single-key bindings. Each handler receives the currently selected
   * index. The same guards (editable target, palette open, modifiers) apply.
   * Only fires when selected >= 0 and selected < count.
   */
  extraKeys?: Record<string, (selected: number) => void>;
}

function inEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  // isContentEditable is the standard property but jsdom may not implement it;
  // fall back to checking the contentEditable attribute string.
  if (el.isContentEditable === true) return true;
  if ((el as HTMLElement).contentEditable === "true") return true;
  return false;
}

export function useListKeys({
  count,
  selected,
  onSelect,
  onActivate,
  onEscape,
  searchRef,
  extraKeys,
}: UseListKeysOptions): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore when palette is open or modifier keys are held.
      if (getPaletteOpen()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Ignore when the event originates inside an editable element.
      if (inEditable(e.target)) return;

      if (e.key === "j" || e.key === "ArrowDown") {
        if (count === 0) return;
        e.preventDefault();
        onSelect(Math.min(count - 1, selected < 0 ? 0 : selected + 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        if (count === 0) return;
        e.preventDefault();
        onSelect(Math.max(0, selected < 0 ? 0 : selected - 1));
      } else if (e.key === "Enter") {
        if (selected >= 0 && selected < count) {
          e.preventDefault();
          onActivate(selected);
        }
      } else if (e.key === "Escape") {
        onEscape?.();
      } else if (e.key === "/") {
        if (searchRef?.current) {
          e.preventDefault();
          searchRef.current.focus();
        }
      } else if (extraKeys && e.key in extraKeys) {
        if (selected >= 0 && selected < count) {
          e.preventDefault();
          extraKeys[e.key](selected);
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, selected, onSelect, onActivate, onEscape, searchRef, extraKeys]);
}
