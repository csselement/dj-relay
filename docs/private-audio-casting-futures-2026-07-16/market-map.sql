-- Reviewed market categories and current examples, checked July 16, 2026.
-- This is a qualitative product map rather than a complete vendor census.
WITH layers(layer, current_examples, established_job, remaining_opening) AS (
  VALUES
    ('Podcast production', 'RØDECaster and software recording suites', 'Mix microphones, guests, effects, and multitrack recordings', 'Little opening for another general studio console'),
    ('Internet live audio', 'Mixlr', 'Public or access-controlled live audio, archives, embeds, and listener analytics', 'A trusted source-side appliance and physical-room workflow'),
    ('Creator live membership', 'Patreon Live', 'Ticketed or member-only creator livestreams and replays', 'Automatic capture from real-world rooms without a production operator'),
    ('Private podcast delivery', 'Transistor and Hello Audio', 'Per-listener private RSS feeds for memberships, courses, and internal audio', 'Live-to-private-feed automation from a physical source'),
    ('Local venue listening', 'ListenWIFI and Auracast', 'Low-latency nearby audio, accessibility, silent screens, tours, and language channels', 'One endpoint that serves nearby and remote listeners'),
    ('Live translation', 'LiveTranslation.ai, Talkeando, and similar services', 'AI captions and translated speech delivered by QR or browser', 'Persistent venue ingest and simpler installed operation'),
    ('Acoustic monitoring', 'Industrial acoustic monitoring and conservation sensors', 'Detect machine faults, wildlife, threats, or environmental events', 'Human listen-in, private alert rooms, and a simpler horizontal gateway')
)
SELECT layer, current_examples, established_job, remaining_opening
FROM layers;
