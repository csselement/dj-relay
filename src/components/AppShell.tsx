import type { ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle";

export function AppShell({ children, footer = "Keep this tab open while you play." }: { children: ReactNode; footer?: string }) {
  return (
    <div className={`app-shell ${footer ? "" : "app-shell-no-footer"}`}>
      <header className="app-header">
        <div className="app-header-inner">
          <a className="brand" href="/" aria-label="Discus home">
            <span className="brand-mark brand-disc" aria-hidden="true" />
            <span>Discus</span>
          </a>
          <ThemeToggle />
        </div>
      </header>
      <main className="app-content">{children}</main>
      {footer && <footer className="app-footer">{footer}</footer>}
    </div>
  );
}
