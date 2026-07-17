-- Product evidence extracted on July 16, 2026 from the local AudioBox
-- documentation/server implementation and the local Discus repository.
WITH product_synthesis(dimension, audiobox, discus, hybrid) AS (
  VALUES
    ('Broadcaster', 'Dedicated analog-input Raspberry Pi encoder', 'DJ browser captures an audio device', 'Dedicated booth encoder publishes into a Discus-managed session'),
    ('Control', 'Local web panel and manual stream configuration', 'Owner console, role-specific links, session states', 'Physical start/stop plus owner web console and remote device status'),
    ('Distribution', 'Separate Icecast Pi, DDNS, port forwarding, persistent player', 'Managed MediaMTX relay with expiring listener access', 'Outbound-only device connection to managed relay and disposable rooms'),
    ('Failure handling', 'Capture Pi, LAN, Icecast Pi, and router troubleshooting', 'Reconnect state, grace period, listener buffering, session closure', 'Local lossless recording plus automatic stream recovery and fleet alerts'),
    ('Ideal user', 'Any analog source, broadly described', 'Computer-based invited DJ and small listener group', 'Recurring venue or collective with analog mixer output and rotating DJs'),
    ('Listener experience', 'Public Icecast HTML player and server statistics', 'Private browser room, no listener account, sharing, live state', 'Keep the Discus room and listener workflow')
)
SELECT dimension, audiobox, discus, hybrid
FROM product_synthesis;
