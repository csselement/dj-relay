import { Button } from "antd";
import { useTheme } from "./DesignSystemProvider";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <Button className="theme-toggle" type="text" size="small" aria-label={`Use ${nextTheme} mode`} onClick={() => setTheme(nextTheme)}>
      {nextTheme === "light" ? "Light mode" : "Dark mode"}
    </Button>
  );
}
