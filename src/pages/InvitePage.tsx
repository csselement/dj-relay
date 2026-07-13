import { useEffect, useState } from "react";
import { api } from "../api";
import { AppShell } from "../components/AppShell";

export function InvitePage({ token }: { token: string }) {
  const [error, setError] = useState("");
  useEffect(() => {
    void api<{ destination: string }>("/api/invite/exchange", {
      method: "POST",
      body: JSON.stringify({ token }),
    }).then(({ destination }) => {
      window.history.replaceState({}, "", destination);
      window.location.reload();
    }).catch((caught) => setError(caught instanceof Error ? caught.message : "Unable to open this invite"));
  }, [token]);
  return (
    <AppShell footer="">
      <div className="message-view">
        <h1>{error ? "Invite unavailable" : "Opening session"}</h1>
        <p className="intro-copy">{error || "Checking your private invite…"}</p>
      </div>
    </AppShell>
  );
}
