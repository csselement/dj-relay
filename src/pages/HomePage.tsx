import { AppShell } from "../components/AppShell";

export function HomePage() {
  return (
    <AppShell footer="Private audio sessions for invited DJs and listeners.">
      <div className="message-view">
        <h1>Private relay</h1>
        <p className="intro-copy">Open the private link you received to join a session.</p>
        <a className="link-button" href="/admin">Owner console</a>
      </div>
    </AppShell>
  );
}
