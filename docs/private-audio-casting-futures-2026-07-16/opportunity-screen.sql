-- Founder-screen heuristic for private-audio opportunities, July 16, 2026.
-- Each dimension is scored 1-5. The weighted score is directional judgment,
-- not measured market size or customer demand.
-- Weights: recurring buyer 25%, hardware leverage 25%, private-audio value 20%,
-- competitive whitespace 20%, and fit with AudioBox/Discus assets 10%.
WITH opportunities(opportunity, recurring_buyer, hardware_leverage, private_audio_value, whitespace, current_fit) AS (
  VALUES
    ('Rooms become podcasts', 4, 5, 4, 4, 5),
    ('Acoustic observability', 5, 5, 5, 3, 1),
    ('Access + translation', 5, 5, 4, 2, 4),
    ('Youth sports radio', 4, 4, 5, 3, 4),
    ('Sonic windows', 3, 5, 4, 4, 3),
    ('Homebound gatherings', 4, 5, 5, 1, 4),
    ('Civic/classroom sideband', 4, 4, 4, 3, 3),
    ('Family ceremonies', 3, 4, 5, 2, 4),
    ('Creator aftershows', 3, 2, 5, 2, 5)
)
SELECT
  opportunity,
  recurring_buyer,
  hardware_leverage,
  private_audio_value,
  whitespace,
  current_fit,
  ROUND((recurring_buyer * 0.25 + hardware_leverage * 0.25 + private_audio_value * 0.20 + whitespace * 0.20 + current_fit * 0.10) / 5 * 100, 0) AS screen_score
FROM opportunities
ORDER BY screen_score DESC;
