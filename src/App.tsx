import { AdminPage } from "./pages/AdminPage";
import { BroadcasterPage } from "./pages/BroadcasterPage";
import { HomePage } from "./pages/HomePage";
import { InvitePage } from "./pages/InvitePage";
import { ListenerPage } from "./pages/ListenerPage";
import { RecordingsPage } from "./pages/RecordingsPage";

export function App() {
  const path = window.location.pathname;
  if (path === "/admin") return <AdminPage />;
  if (path === "/admin/recordings") return <RecordingsPage />;
  if (path === "/broadcast") return <BroadcasterPage />;
  if (path === "/listen") return <ListenerPage />;
  if (path.startsWith("/s/")) return <InvitePage token={decodeURIComponent(path.slice(3))} />;
  return <HomePage />;
}
