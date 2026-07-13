import { Alert } from "antd";

export function InlineNotice({ tone = "neutral", children }: { tone?: "neutral" | "success" | "danger"; children: React.ReactNode }) {
  return (
    <Alert
      className={`inline-notice inline-notice-${tone}`}
      message={children}
      role={tone === "danger" ? "alert" : "status"}
      showIcon={false}
      type={tone === "danger" ? "error" : tone === "success" ? "success" : "info"}
    />
  );
}
