-- Directional price normalization using ECB reference rates for July 16, 2026:
-- EUR/USD 1.1467 and EUR/GBP 0.84873.
-- Source: https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html
WITH prices(product, native_amount, native_currency) AS (
  VALUES
    ('IK iRig Stream', 119.99, 'USD'),
    ('EvermixBox5', 159.00, 'GBP'),
    ('Howler MK2', 219.00, 'EUR'),
    ('Barix Instreamer ICE', 485.00, 'USD')
), normalized AS (
  SELECT
    product,
    native_amount,
    native_currency,
    CASE
      WHEN native_currency = 'GBP' THEN native_amount / 0.84873 * 1.1467
      WHEN native_currency = 'EUR' THEN native_amount * 1.1467
      ELSE native_amount
    END AS approx_usd
  FROM prices
)
SELECT product, native_amount, native_currency, ROUND(approx_usd, 0) AS approx_usd
FROM normalized;
