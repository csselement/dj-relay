import { Button } from "antd";
import { Moon, Sun } from "@phosphor-icons/react";
import { useTheme } from "./DesignSystemProvider";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <Button
      className="theme-toggle"
      type="text"
      aria-label={`Use ${nextTheme} mode`}
      title={`Use ${nextTheme} mode`}
      onClick={() => setTheme(nextTheme)}
    >
      <span className="t-icon-swap" data-state={nextTheme === "light" ? "a" : "b"}>
        <span className="t-icon" data-icon="a"><Sun size={20} weight="bold" aria-hidden="true" /></span>
        <span className="t-icon" data-icon="b"><Moon size={20} weight="bold" aria-hidden="true" /></span>
      </span>
    </Button>
  );
}
