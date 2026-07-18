import { useEffect, useId, useRef, useState } from "react";
import { Button, Tooltip } from "antd";
import { Check, CopySimple, ShareNetwork } from "@phosphor-icons/react";
import { sessionApi } from "../api";
import { copyText } from "../clipboard";
import { AnimatedText } from "./AnimatedText";
import { InlineNotice } from "./InlineNotice";

type SessionShareProps = {
  sessionId: string;
  label: string;
  description: string;
  errorMessage: string;
  className?: string;
  variant?: "panel" | "icon";
};

export function SessionShare({
  sessionId,
  label,
  description,
  errorMessage,
  className = "",
  variant = "panel",
}: SessionShareProps) {
  const [shareUrl, setShareUrl] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number>(undefined);
  const labelId = useId();

  useEffect(() => {
    let active = true;
    setShareUrl("");
    setError("");
    void sessionApi.shareLink().then(({ url }) => {
      if (!active) return;
      setShareUrl(url);
    }).catch(() => {
      if (active) setError(errorMessage);
    });
    return () => { active = false; };
  }, [errorMessage, sessionId]);

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
    const label = copied ? "Link copied" : error || "Copy session link";
    return (
      <Tooltip title="Link copied" open={copied} placement="bottomRight">
        <Button
          className={`session-share-icon-button ${className}`.trim()}
          disabled={!shareUrl}
          loading={!shareUrl && !error}
          aria-label={label}
          title={copied ? undefined : label}
          onClick={() => void copyShareLink()}
        >
          <span className="t-icon-swap" data-state={copied ? "b" : "a"} aria-hidden="true">
            <ShareNetwork className="t-icon" data-icon="a" size={19} weight="bold" />
            <Check className="t-icon" data-icon="b" size={19} weight="bold" />
          </span>
        </Button>
      </Tooltip>
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
          <Button className="copy-button listener-copy-button" onClick={() => void copyShareLink()}>
            <span className="t-icon-swap" data-state={copied ? "b" : "a"} aria-hidden="true">
              <CopySimple className="t-icon" data-icon="a" size={18} weight="bold" />
              <Check className="t-icon" data-icon="b" size={18} weight="bold" />
            </span>
            <AnimatedText value={copied ? "Link copied" : "Copy link"} />
          </Button>
        </section>
      )}
      {error && <InlineNotice tone="danger">{error}</InlineNotice>}
    </>
  );
}
