-- Reproducible representation of prices and positioning manually reviewed from
-- the official URLs recorded in competitor-pricing.csv on July 16, 2026.
WITH entry_prices(offer, monthly_usd, billing_basis) AS (
  VALUES
    ('Livesets', 0.00, 'Free'),
    ('SonoBus', 0.00, 'Free and open source'),
    ('Mixlr Beginner', 0.00, '3 live hours per month'),
    ('LISTENTO Basic, annual', 4.99, '$59.99 billed annually'),
    ('LISTENTO Pro, annual', 9.99, '$119.99 billed annually'),
    ('Radio.co Lite', 35.00, 'Monthly price shown'),
    ('Mixlr Intermediate', 49.00, 'Monthly; $38 monthly equivalent annually')
)
SELECT offer, monthly_usd, billing_basis
FROM entry_prices;
