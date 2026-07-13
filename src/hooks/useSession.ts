import { useCallback, useEffect, useState } from "react";
import { sessionApi } from "../api";
import type { SessionResponse } from "../types";

export function useSession(expectedRole: "dj" | "listener") {
  const [data, setData] = useState<SessionResponse | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const next = await sessionApi.get();
      if (next.role !== expectedRole) throw new Error("This invite link is for a different role");
      setData(next);
      setError("");
      return next;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load this session");
      return null;
    }
  }, [expectedRole]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { data, error, refresh };
}
