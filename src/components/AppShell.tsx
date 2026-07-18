import type { ReactNode } from "react";

type AppShellProps = {
  children: ReactNode;
  contentClassName?: string;
  footer?: ReactNode;
  shellClassName?: string;
};

export function AppShell({
  children,
  contentClassName = "",
  footer = "Keep this tab open while you play.",
  shellClassName = "",
}: AppShellProps) {
  return (
    <div className={`app-shell ${footer ? "" : "app-shell-no-footer"} ${shellClassName}`.trim()}>
      <header className="app-header">
        <div className="app-header-inner">
          <a className="brand" href="/" aria-label="Discus home">
            <span className="brand-mark brand-disc" aria-hidden="true" />
            <span>Discus</span>
          </a>
          <div className="app-header-actions">
            <a className="header-console-link" href="/admin">Producer console</a>
          </div>
        </div>
      </header>
      <main className={`app-content ${contentClassName}`.trim()}>{children}</main>
      {footer && <footer className="app-footer">{footer}</footer>}
    </div>
  );
}
