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
      {nextTheme === "light"
        ? <Sun size={20} weight="bold" aria-hidden="true" />
        : <Moon size={20} weight="bold" aria-hidden="true" />}
    </Button>
  );
}
