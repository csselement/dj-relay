-- Reproducible representation of current Discus capabilities reviewed in
-- README.md, src/media.ts, src/pages, server/config.ts, and server/app.ts.
WITH product_evidence(dimension, current_state, market_effect) AS (
  VALUES
    ('Audience scale', '20-listener configured ceiling and one private relay at a time', 'Suitable for pilots and intimate rooms; not competitive for public broadcasts or large events.'),
    ('Broadcaster setup', 'Chrome or Edge, HTTPS, mixer/interface input, device selection, stereo meter, five-second test', 'Strong usability wedge, though browser and audio-routing edge cases will create support load.'),
    ('Distribution', 'Expiring listener links, listener re-sharing, optional Discord live announcement', 'Good fit for private communities; lacks discovery, persistent channels, embeds, and follower growth.'),
    ('Listener friction', 'Browser link with no listener account or installed client', 'The clearest differentiation against professional collaboration apps and community platforms.'),
    ('Reliability', 'WebRTC reconnect, 60-second DJ grace period, 500 ms listener jitter target, self-hosted deployment', 'Promising mechanics, but no external uptime, device-coverage, or load evidence yet.'),
    ('Rights and safety', 'Private access controls; no music licensing, content identification, royalty reporting, moderation, or takedown workflow', 'Material launch risk for commercial DJ streaming; privacy must not be marketed as licensing.'),
    ('Sound', 'Stereo Opus targeted at 192 kbps and 48 kHz capture', 'Credible listening quality, but not a defensible lead against lossless pro-audio tools.')
)
SELECT dimension, current_state, market_effect
FROM product_evidence;
