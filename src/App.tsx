import { lazy, Suspense } from "react";
import { HomePage } from "./pages/HomePage";

const AdminRoute = lazy(() => import("./routes/AdminRoute"));
const BroadcasterRoute = lazy(() => import("./routes/BroadcasterRoute"));
const ListenerRoute = lazy(() => import("./routes/ListenerRoute"));
const InvitePage = lazy(() => import("./pages/InvitePage").then((module) => ({ default: module.InvitePage })));

function RouteFallback() {
  return <div className="route-loading" role="status">Loading…</div>;
}

export function App() {
  const path = window.location.pathname;
  let route = <HomePage />;
  if (path === "/admin" || path === "/admin/recordings") route = <AdminRoute />;
  else if (path === "/broadcast") route = <BroadcasterRoute />;
  else if (path === "/listen") route = <ListenerRoute />;
  else if (path.startsWith("/s/")) route = <InvitePage token={decodeURIComponent(path.slice(3))} />;
  return <Suspense fallback={<RouteFallback />}>{route}</Suspense>;
}
