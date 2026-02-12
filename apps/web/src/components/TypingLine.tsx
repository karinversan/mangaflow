"use client";

import { useEffect, useMemo, useState } from "react";

type TypingLineProps = {
  lines: string[];
  speed?: number;
  pauseMs?: number;
};

export function TypingLine({ lines, speed = 32, pauseMs = 1400 }: TypingLineProps) {
  const [lineIndex, setLineIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);

  const currentLine = useMemo(() => lines[lineIndex] ?? "", [lines, lineIndex]);

  useEffect(() => {
    if (!lines.length) return;

    if (charIndex < currentLine.length) {
      const timer = setTimeout(() => setCharIndex((prev) => prev + 1), speed);
      return () => clearTimeout(timer);
    }

    const pauseTimer = setTimeout(() => {
      setCharIndex(0);
      setLineIndex((prev) => (prev + 1) % lines.length);
    }, pauseMs);

    return () => clearTimeout(pauseTimer);
  }, [charIndex, currentLine.length, lines.length, pauseMs, speed]);

  return (
    <p className="text-base text-white/85 sm:text-lg">
      {currentLine.slice(0, charIndex)}
      <span className="ml-0.5 inline-block h-5 w-[2px] animate-pulse bg-white/80 align-middle" />
    </p>
  );
}
