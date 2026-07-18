import { useEffect, useId, useRef, useState } from "react";
import { Button } from "antd";
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
    const label = copied ? "Session link copied" : error || "Copy session link";
    return (
      <Button
        className={`session-share-icon-button ${className}`.trim()}
        disabled={!shareUrl}
        loading={!shareUrl && !error}
        aria-label={label}
        title={label}
        onClick={() => void copyShareLink()}
      >
        {copied
          ? <Check size={19} weight="bold" aria-hidden="true" />
          : <ShareNetwork size={19} weight="bold" aria-hidden="true" />}
      </Button>
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
            <CopySimple size={18} weight="bold" aria-hidden="true" />
            <AnimatedText value={copied ? "Copied" : "Copy link"} />
          </Button>
        </section>
      )}
      {error && <InlineNotice tone="danger">{error}</InlineNotice>}
    </>
  );
}
