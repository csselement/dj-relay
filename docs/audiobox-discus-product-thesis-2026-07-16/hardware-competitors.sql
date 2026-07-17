-- Public hardware prices and product characteristics checked July 16, 2026.
-- Native currencies are preserved to avoid false precision from conversion.
WITH competitors(product, public_price, external_device, positioning, remaining_gap) AS (
  VALUES
    ('Barix Instreamer ICE', '$485', 'None after network configuration', 'Professional stereo line-level MP3/AAC Icecast encoder', 'Standalone but generic and not a DJ session product'),
    ('EvermixBox5', '£159', 'Phone or tablet', 'DJ recording and livestreaming with no laptop', 'Still depends on a personal mobile device and app'),
    ('Howler MK2', '€219', 'Phone, tablet, or computer for livestreaming', 'Rugged one-button recording and phone-streaming interface', 'Not a standalone managed network encoder'),
    ('IK Multimedia iRig Stream', '$119.99 at B&H', 'Phone, tablet, Mac, or PC', 'Portable RCA interface for popular recording and streaming apps', 'Interface only; user supplies distribution workflow'),
    ('AlphaTheta DJM-REC', 'Free app; paid advanced features after trial', 'Compatible iPhone and mixer', 'One-cable recording and livestreaming', 'Phone-dependent and limited to supported mixer ecosystem')
)
SELECT product, public_price, external_device, positioning, remaining_gap
FROM competitors;
