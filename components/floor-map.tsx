"use client";

// Zoomable, pannable house-map drawing. Renders the SVG string from
// lib/floorplan.ts and drives its viewBox:
//   - + / − / Fit buttons
//   - pinch, or ⌘/Ctrl + scroll → zoom around the cursor
//   - drag (mouse or one finger) → pan; two-finger scroll pans once zoomed
//   - tap/click a room → select it and ease the view to frame it
// Zoom math is in lib/floorplan.ts (zoomViewBox / fitViewBox / clamp).

import React, { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Button } from "@heroui/button";
import { FaCompressArrowsAlt, FaMinus, FaPlus } from "react-icons/fa";

import {
  clampViewBox,
  fitViewBox,
  formatViewBox,
  parseViewBox,
  zoomViewBox,
  type Point,
  type ViewBox,
} from "@/lib/floorplan";

const DRAG_THRESHOLD_PX = 4;
const ANIMATION_MS = 280;

export function FloorMap({
  svg,
  resetKey,
  roomPoints,
  selectedRoomId,
  onSelect,
  className = "",
}: {
  /** Full SVG markup from buildFloorSvg. */
  svg: string;
  /** Changing this (e.g. the floor id) resets the view to fit. */
  resetKey: string;
  /** Outline per room id, for zoom-to-room. */
  roomPoints: Map<string, Point[]>;
  selectedRoomId: string | null;
  onSelect: (roomId: string | null) => void;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fullRef = useRef<ViewBox | null>(null);
  const viewRef = useRef<ViewBox | null>(null);
  const keyRef = useRef<string | null>(null);
  const animRef = useRef<number | null>(null);

  const svgEl = () => hostRef.current?.querySelector("svg") ?? null;

  const apply = useCallback((v: ViewBox) => {
    viewRef.current = v;
    svgEl()?.setAttribute("viewBox", formatViewBox(v));
  }, []);

  const stopAnim = () => {
    if (animRef.current != null) cancelAnimationFrame(animRef.current);
    animRef.current = null;
  };

  const animateTo = useCallback(
    (target: ViewBox) => {
      stopAnim();
      const from = viewRef.current ?? target;
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ANIMATION_MS);
        const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
        apply({
          x: from.x + (target.x - from.x) * e,
          y: from.y + (target.y - from.y) * e,
          w: from.w + (target.w - from.w) * e,
          h: from.h + (target.h - from.h) * e,
        });
        animRef.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      animRef.current = requestAnimationFrame(step);
    },
    [apply],
  );

  // New markup (selection, badges, floor change) replaces the <svg>, so
  // re-apply the current view — or reset it when the floor changed.
  useLayoutEffect(() => {
    const el = svgEl();
    if (!el) return;
    const full = parseViewBox(el.getAttribute("viewBox"));
    if (!full) return;
    const floorChanged = keyRef.current !== resetKey;
    keyRef.current = resetKey;
    const prevFull = fullRef.current;
    fullRef.current = full;
    if (floorChanged || !viewRef.current || !prevFull) {
      stopAnim();
      viewRef.current = full;
      return;
    }
    // Same floor: keep the view (clamped in case the drawing grew/shrank).
    apply(clampViewBox(viewRef.current, full));
  }, [svg, resetKey, apply]);

  // Selecting a room (here or from the side panel) frames it.
  useEffect(() => {
    const full = fullRef.current;
    const pts = selectedRoomId ? roomPoints.get(selectedRoomId) : undefined;
    if (full && pts && pts.length >= 3) animateTo(fitViewBox(pts, full));
  }, [selectedRoomId, roomPoints, animateTo]);

  useEffect(() => stopAnim, []);

  // ── Coordinates ──────────────────────────────────────────────────────────
  function toDrawing(clientX: number, clientY: number): Point | null {
    const el = svgEl();
    const ctm = el?.getScreenCTM();
    if (!el || !ctm) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }
  function unitsPerPx(): number {
    const ctm = svgEl()?.getScreenCTM();
    return ctm && ctm.a ? 1 / ctm.a : 0;
  }

  function zoomAt(factor: number, clientX?: number, clientY?: number) {
    const full = fullRef.current;
    const v = viewRef.current;
    if (!full || !v) return;
    stopAnim();
    const at =
      clientX != null && clientY != null
        ? toDrawing(clientX, clientY)
        : { x: v.x + v.w / 2, y: v.y + v.h / 2 };
    if (at) apply(zoomViewBox(v, factor, at, full));
  }

  function panBy(dxPx: number, dyPx: number) {
    const full = fullRef.current;
    const v = viewRef.current;
    if (!full || !v) return;
    const u = unitsPerPx();
    apply(clampViewBox({ ...v, x: v.x - dxPx * u, y: v.y - dyPx * u }, full));
  }

  const zoomedIn = () => {
    const full = fullRef.current;
    const v = viewRef.current;
    return !!full && !!v && v.w < full.w - 1e-6;
  };

  // Wheel needs a non-passive listener to be able to preventDefault.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        // Trackpad pinch arrives as ctrl+wheel.
        e.preventDefault();
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      } else if (zoomedIn()) {
        e.preventDefault();
        stopAnim();
        panBy(-e.deltaX, -e.deltaY);
      }
      // Not zoomed and no modifier: let the page scroll.
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Pointer: drag to pan, pinch to zoom, tap to select ──────────────────
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startX: number; startY: number; moved: boolean; target: Element | null; pinchDist: number | null }>({
    startX: 0,
    startY: 0,
    moved: false,
    target: null,
    pinchDist: null,
  });

  function onPointerDown(e: React.PointerEvent) {
    if ((e.target as Element).closest("button")) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      gesture.current = { startX: e.clientX, startY: e.clientY, moved: false, target: e.target as Element, pinchDist: null };
    } else if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      gesture.current.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      gesture.current.moved = true; // a pinch is never a tap
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;

    if (pointers.current.size >= 2 && g.pinchDist) {
      const [a, b] = Array.from(pointers.current.values());
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > 0) {
        zoomAt(dist / g.pinchDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
        g.pinchDist = dist;
      }
      return;
    }
    if (!g.moved && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > DRAG_THRESHOLD_PX) {
      g.moved = true;
      stopAnim();
    }
    if (g.moved) panBy(e.clientX - prev.x, e.clientY - prev.y);
  }

  function onPointerUp(e: React.PointerEvent) {
    const wasTap = pointers.current.size === 1 && !gesture.current.moved;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current.pinchDist = null;
    if (!wasTap) return;
    const id = gesture.current.target?.closest?.("[data-room-id]")?.getAttribute("data-room-id") ?? null;
    onSelect(id && id === selectedRoomId ? null : id);
  }

  function onPointerCancel(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    gesture.current.pinchDist = null;
  }

  function fit() {
    if (fullRef.current) animateTo(fullRef.current);
  }

  return (
    <div className={`relative ${className}`}>
      <div
        ref={hostRef}
        className="select-none cursor-grab active:cursor-grabbing [touch-action:none] [&_svg]:max-h-[70vh] [&_svg]:w-full"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        // Generated by lib/floorplan.ts from our own data; all text is escaped there.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="absolute top-2 right-2 flex flex-col gap-1">
        <Button isIconOnly size="sm" variant="flat" aria-label="Zoom in" onPress={() => zoomAt(1.5)}>
          <FaPlus size={11} />
        </Button>
        <Button isIconOnly size="sm" variant="flat" aria-label="Zoom out" onPress={() => zoomAt(1 / 1.5)}>
          <FaMinus size={11} />
        </Button>
        <Button isIconOnly size="sm" variant="flat" aria-label="Fit to screen" onPress={fit}>
          <FaCompressArrowsAlt size={11} />
        </Button>
      </div>
    </div>
  );
}
