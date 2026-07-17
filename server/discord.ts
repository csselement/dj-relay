export type DiscordSessionAnnouncement = {
  webhookUrl: string | null;
  sessionId: string;
  sessionName: string;
  listenerUrl: string;
};

type DiscordNotifierOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: Pick<Console, "log" | "error">;
};

export async function announceDiscordSession(
  announcement: DiscordSessionAnnouncement,
  options: DiscordNotifierOptions = {},
): Promise<void> {
  if (!announcement.webhookUrl) return;

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_500;
  const logger = options.logger ?? console;

  try {
    const response = await fetchImpl(announcement.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `🎧 **${announcement.sessionName} is live on Discus**\nListen now: ${announcement.listenerUrl}`,
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}`);
    logger.log(JSON.stringify({
      level: "info",
      message: "Discord session announcement sent",
      sessionId: announcement.sessionId,
    }));
  } catch (error) {
    logger.error(JSON.stringify({
      level: "error",
      message: "Discord session announcement failed",
      sessionId: announcement.sessionId,
      error: error instanceof Error ? error.message : "Unknown error",
    }));
  }
}
