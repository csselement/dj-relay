import { useEffect, useId, useRef, useState } from "react";
import { Button, Tooltip } from "antd";
import { Check, CopySimple, ShareNetwork } from "@phosphor-icons/react";
import { sessionApi } from "../api";
import { copyText } from "../clipboard";
import { AnimatedText } from "./AnimatedText";
import { InlineNotice } from "./InlineNotice";

type SessionShareProps = {
  sessionId: string;
  role?: "dj" | "listener";
  label: string;
  description: string;
  errorMessage: string;
  className?: string;
  variant?: "panel" | "icon";
  copyLabel?: string;
};

export function SessionShare({
  sessionId,
  role = "listener",
  label,
  description,
  errorMessage,
  className = "",
  variant = "panel",
  copyLabel = "Copy session link",
}: SessionShareProps) {
  const [shareUrl, setShareUrl] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number>(undefined);
  const labelId = useId();
  const copySubject = copyLabel.replace(/^Copy /, "");
  const copiedLabel = `${copySubject.charAt(0).toUpperCase()}${copySubject.slice(1)} copied`;

  useEffect(() => {
    let active = true;
    setShareUrl("");
    setError("");
    void sessionApi.shareLink(role).then(({ url }) => {
      if (!active) return;
      setShareUrl(url);
    }).catch(() => {
      if (active) setError(errorMessage);
    });
    return () => { active = false; };
  }, [errorMessage, role, sessionId]);

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), []);

  async function copyShareLink() {
    if (!shareUrl) return;
    try {
      await copyText(shareUrl);
      setCopied(true);
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy the link. Select the link and copy it manually.");
    }
  }

  if (variant === "icon") {
    const buttonLabel = copied ? copiedLabel : error || copyLabel;
    return (
      <>
        <Tooltip title={copiedLabel} open={copied} placement="bottomRight">
          <Button
            className={`session-share-icon-button ${className}`.trim()}
            disabled={!shareUrl}
            loading={!shareUrl && !error}
            aria-label={buttonLabel}
            title={copied ? undefined : buttonLabel}
            onClick={() => void copyShareLink()}
          >
            <span className="t-icon-swap" data-state={copied ? "b" : "a"} aria-hidden="true">
              <ShareNetwork className="t-icon" data-icon="a" size={19} weight="bold" />
              <Check className="t-icon" data-icon="b" size={19} weight="bold" />
            </span>
          </Button>
        </Tooltip>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{copied ? copiedLabel : ""}</span>
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      </>
    );
  }

  return (
    <>
      {shareUrl && (
        <section className={`listener-share ${className}`.trim()} aria-labelledby={labelId}>
          <div className="listener-share-copy">
            <strong id={labelId}>{label}</strong>
            <a href={shareUrl} target="_blank" rel="noreferrer">{shareUrl}</a>
            <span>{description}</span>
          </div>
          <Button className="copy-button listener-copy-button" aria-label={copied ? copiedLabel : copyLabel} onClick={() => void copyShareLink()}>
            <span className="t-icon-swap" data-state={copied ? "b" : "a"} aria-hidden="true">
              <CopySimple className="t-icon" data-icon="a" size={18} weight="bold" />
              <Check className="t-icon" data-icon="b" size={18} weight="bold" />
            </span>
            <AnimatedText value={copied ? copiedLabel : copyLabel} />
          </Button>
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{copied ? copiedLabel : ""}</span>
        </section>
      )}
      {error && <InlineNotice tone="danger">{error}</InlineNotice>}
    </>
  );
}
