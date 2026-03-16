"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ToolMode } from "./types";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function useCanvas(imageWidth: number, imageHeight: number) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [zoomPercent, setZoomPercent] = useState(100);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [toolMode, setToolMode] = useState<ToolMode>("select");
  const [isSpacePanning, setIsSpacePanning] = useState(false);

  const effectiveToolMode: ToolMode = isSpacePanning ? "pan" : toolMode;

  const displayedRect = useMemo(() => {
    if (!imageWidth || !imageHeight) return { width: 1, height: 1, x: 0, y: 0, scale: 1 };
    const pad = 8;
    const maxW = Math.max(100, stageSize.width - pad * 2);
    const maxH = Math.max(100, stageSize.height - pad * 2);
    const fitScale = Math.min(maxW / imageWidth, maxH / imageHeight);
    const scale = fitScale * (zoomPercent / 100);
    const width = Math.round(imageWidth * scale);
    const height = Math.round(imageHeight * scale);
    return { width, height, x: Math.round((stageSize.width - width) / 2), y: Math.round((stageSize.height - height) / 2), scale };
  }, [imageWidth, imageHeight, stageSize, zoomPercent]);

  // Resize observer
  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const syncSize = () => {
      const rect = element.getBoundingClientRect();
      setStageSize({ width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) });
    };
    syncSize();
    const observer = new ResizeObserver(() => syncSize());
    observer.observe(element);
    window.addEventListener("resize", syncSize);
    const raf = requestAnimationFrame(syncSize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", syncSize); observer.disconnect(); };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => { const el = t as HTMLElement | null; if (!el) return false; const tag = el.tagName?.toLowerCase(); return tag === "input" || tag === "textarea" || el.isContentEditable; };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTyping(e.target)) {
        if (e.code === "Space") { e.preventDefault(); setIsSpacePanning(true); }
        if (e.key.toLowerCase() === "v") setToolMode("select");
        if (e.key.toLowerCase() === "h") setToolMode("pan");
        if (e.key.toLowerCase() === "z") setToolMode("zoom");
      }
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === "Space") { setIsSpacePanning(false); } };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
  }, []);

  const zoomAtPoint = useCallback((clientX: number, clientY: number, delta: number) => {
    if (!stageRef.current) return;
    const nextZoom = clamp(zoomPercent + delta, 40, 600);
    if (nextZoom === zoomPercent) return;
    const stageRect = stageRef.current.getBoundingClientRect();
    const pointerX = clientX - stageRect.left;
    const pointerY = clientY - stageRect.top;
    const currentLeft = displayedRect.x + panOffset.x;
    const currentTop = displayedRect.y + panOffset.y;
    const anchorX = (pointerX - currentLeft) / Math.max(1, displayedRect.width);
    const anchorY = (pointerY - currentTop) / Math.max(1, displayedRect.height);
    const zoomFactor = nextZoom / zoomPercent;
    const nextWidth = displayedRect.width * zoomFactor;
    const nextHeight = displayedRect.height * zoomFactor;
    const nextCenterX = (stageSize.width - nextWidth) / 2;
    const nextCenterY = (stageSize.height - nextHeight) / 2;
    const nextLeft = pointerX - anchorX * nextWidth;
    const nextTop = pointerY - anchorY * nextHeight;
    setZoomPercent(nextZoom);
    setPanOffset({ x: nextLeft - nextCenterX, y: nextTop - nextCenterY });
  }, [zoomPercent, panOffset, displayedRect, stageSize]);

  const resetView = useCallback(() => { setZoomPercent(100); setPanOffset({ x: 0, y: 0 }); }, []);

  return {
    stageRef, stageSize, zoomPercent, setZoomPercent, panOffset, setPanOffset,
    toolMode, setToolMode, effectiveToolMode, isSpacePanning, setIsSpacePanning,
    displayedRect, zoomAtPoint, resetView,
  };
}
