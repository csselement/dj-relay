import { DesignSystemProvider } from "../components/DesignSystemProvider";
import { AdminPage } from "../pages/AdminPage";

export default function AdminRoute() {
  return <DesignSystemProvider><AdminPage /></DesignSystemProvider>;
}
