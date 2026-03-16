"use client";
import { useEffect, useState } from "react";
import { issueDevToken } from "@/lib/api";

export function useAuth() {
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const initToken = async () => {
      try {
        const storageKey = "mangaflow_dev_user_id";
        const existing = window.localStorage.getItem(storageKey);
        const userId = existing || `dev-user-${Math.random().toString(36).slice(2, 10)}`;
        if (!existing) window.localStorage.setItem(storageKey, userId);
        let attempt = 0;
        while (!cancelled) {
          try {
            const token = await issueDevToken(userId);
            if (!cancelled) { setAuthToken(token); setNotice(null); }
            return;
          } catch {
            attempt += 1;
            if (!cancelled && attempt === 5) setNotice("JWT dev-token temporarily unavailable. Reconnecting...");
            await new Promise(r => setTimeout(r, Math.min(5_000, 600 + attempt * 500)));
          }
        }
      } catch {
        if (!cancelled) setNotice("JWT dev-token unavailable.");
      }
    };
    void initToken();
    return () => { cancelled = true; };
  }, []);

  return { authToken, authNotice: notice };
}
