// Popup placement. All modes clamp to the target display's work area.
//
// Runs under XWayland on Linux (see the Electron pin note in main.ts), where
// screen.getCursorScreenPoint() and window positioning both work.

import { screen } from 'electron';
import { PopupPositionMode } from '../../shared/types';

export const POPUP_WIDTH = 440;
export const POPUP_HEIGHT = 320;

// Gap between the mouse pointer and the popup edge
const POINTER_GAP = 12;

interface Point {
  x: number;
  y: number;
}

export function computePopupPosition(mode: PopupPositionMode): Point {
  try {
    switch (mode) {
      case 'center-primary':
        return centerOf(screen.getPrimaryDisplay());
      case 'center-current':
        return centerOf(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
      case 'mouse':
      default:
        return belowPointer();
    }
  } catch {
    // screen APIs can fail before app ready / on headless — fall back to
    // primary-display center with fixed bounds.
    return { x: 0, y: 0 };
  }
}

function centerOf(display: Electron.Display): Point {
  const area = display.workArea;
  return {
    x: Math.round(area.x + area.width / 2 - POPUP_WIDTH / 2),
    y: Math.round(area.y + area.height / 2 - POPUP_HEIGHT / 2),
  };
}

/** Center a window of the given size on the primary display's work area. */
export function centerOnPrimary(width: number, height: number): Point {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + area.width / 2 - width / 2),
    y: Math.round(area.y + area.height / 2 - height / 2),
  };
}

/** Just below the pointer; flips above it when too close to the bottom. */
function belowPointer(): Point {
  return placeBelowPoint(screen.getCursorScreenPoint());
}

/**
 * Position the popup just below an anchor point, clamped to that point's
 * display work area and flipped above the anchor near the bottom edge.
 */
function placeBelowPoint(anchor: Point): Point {
  const area = screen.getDisplayNearestPoint(anchor).workArea;

  const x = Math.round(
    Math.min(Math.max(anchor.x, area.x), area.x + area.width - POPUP_WIDTH),
  );

  let y = anchor.y + POINTER_GAP;
  if (y + POPUP_HEIGHT > area.y + area.height) {
    y = anchor.y - POPUP_HEIGHT - POINTER_GAP;
  }
  y = Math.round(Math.max(y, area.y));

  return { x, y };
}
