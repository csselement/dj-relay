import { ConfigProvider, theme as antTheme, type ThemeConfig } from "antd";
import type { ReactNode } from "react";

const config: ThemeConfig = {
  algorithm: antTheme.darkAlgorithm,
  cssVar: { key: "dj-relay-dark" },
  token: {
    colorPrimary: "#efeee9",
    colorPrimaryHover: "#ffffff",
    colorBgBase: "#171715",
    colorBgContainer: "#1f1f1c",
    colorBgElevated: "#272723",
    colorText: "#f3f2ed",
    colorTextSecondary: "#a5a49e",
    colorBorder: "#4a4943",
    colorBorderSecondary: "#343430",
    colorTextLightSolid: "#252523",
    colorSuccess: "#b5a07d",
    colorError: "#e28f8c",
    colorWarning: "#d5b873",
    borderRadius: 6,
    borderRadiusLG: 8,
    controlHeight: 42,
    controlHeightLG: 50,
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif',
    boxShadow: "none",
    boxShadowSecondary: "none",
  },
  components: {
    Button: {
      primaryShadow: "none",
      dangerShadow: "none",
      defaultShadow: "none",
      fontWeight: 680,
    },
    Card: {
      bodyPadding: 24,
      bodyPaddingSM: 18,
    },
    Input: {
      activeShadow: "0 0 0 3px #403629",
    },
    Select: {
      activeOutlineColor: "#403629",
    },
  },
};

export function DesignSystemProvider({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider componentSize="large" theme={config} wave={{ disabled: true }}>
      {children}
    </ConfigProvider>
  );
}
