-- Seed 50 Nielsen DMAs into app_accepted_markets.
-- Run manually against limemediaprod_UAT (and prod when ready).
-- Uses MERGE to upsert — safe to re-run.

MERGE dbo.app_accepted_markets AS target
USING (VALUES
  ('DMA-501', 'New York, NY',          40.7128, -74.0060,  1),
  ('DMA-803', 'Los Angeles, CA',       34.0522, -118.2437, 1),
  ('DMA-602', 'Chicago, IL',           41.8781, -87.6298,  1),
  ('DMA-623', 'Dallas-Fort Worth, TX', 32.7767, -96.7970,  1),
  ('DMA-504', 'Philadelphia, PA',      39.9526, -75.1652,  1),
  ('DMA-618', 'Houston, TX',           29.7604, -95.3698,  1),
  ('DMA-524', 'Atlanta, GA',           33.7490, -84.3880,  1),
  ('DMA-511', 'Washington, DC',        38.9072, -77.0369,  1),
  ('DMA-807', 'San Francisco, CA',     37.7749, -122.4194, 1),
  ('DMA-506', 'Boston, MA',            42.3601, -71.0589,  1),
  ('DMA-539', 'Tampa, FL',             27.9506, -82.4572,  1),
  ('DMA-753', 'Phoenix, AZ',           33.4484, -112.0740, 1),
  ('DMA-819', 'Seattle, WA',           47.6062, -122.3321, 1),
  ('DMA-505', 'Detroit, MI',           42.3314, -83.0458,  1),
  ('DMA-534', 'Orlando, FL',           28.5383, -81.3792,  1),
  ('DMA-613', 'Minneapolis, MN',       44.9778, -93.2650,  1),
  ('DMA-751', 'Denver, CO',            39.7392, -104.9903, 1),
  ('DMA-528', 'Miami, FL',             25.7617, -80.1918,  1),
  ('DMA-510', 'Cleveland, OH',         41.4993, -81.6944,  1),
  ('DMA-862', 'Sacramento, CA',        38.5816, -121.4944, 1),
  ('DMA-517', 'Charlotte, NC',         35.2271, -80.8431,  1),
  ('DMA-560', 'Raleigh-Durham, NC',    35.7796, -78.6382,  1),
  ('DMA-820', 'Portland, OR',          45.5152, -122.6784, 1),
  ('DMA-609', 'St. Louis, MO',         38.6270, -90.1994,  1),
  ('DMA-659', 'Nashville, TN',         36.1627, -86.7816,  1),
  ('DMA-527', 'Indianapolis, IN',      39.7684, -86.1581,  1),
  ('DMA-508', 'Pittsburgh, PA',        40.4406, -79.9959,  1),
  ('DMA-770', 'Salt Lake City, UT',    40.7608, -111.8910, 1),
  ('DMA-512', 'Baltimore, MD',         39.2904, -76.6122,  1),
  ('DMA-825', 'San Diego, CA',         32.7157, -117.1611, 1),
  ('DMA-641', 'San Antonio, TX',       29.4241, -98.4936,  1),
  ('DMA-616', 'Kansas City, MO',       39.0997, -94.5786,  1),
  ('DMA-533', 'Hartford, CT',          41.7658, -72.6734,  1),
  ('DMA-635', 'Austin, TX',            30.2672, -97.7431,  1),
  ('DMA-535', 'Columbus, OH',          39.9612, -82.9988,  1),
  ('DMA-567', 'Greenville, SC',        34.8526, -82.3940,  1),
  ('DMA-515', 'Cincinnati, OH',        39.1031, -84.5120,  1),
  ('DMA-617', 'Milwaukee, WI',         43.0389, -87.9065,  1),
  ('DMA-548', 'West Palm Beach, FL',   26.7153, -80.0534,  1),
  ('DMA-839', 'Las Vegas, NV',         36.1699, -115.1398, 1),
  ('DMA-561', 'Jacksonville, FL',      30.3322, -81.6557,  1),
  ('DMA-566', 'Harrisburg, PA',        40.2732, -76.8867,  1),
  ('DMA-563', 'Grand Rapids, MI',      42.9634, -85.6681,  1),
  ('DMA-544', 'Norfolk, VA',           36.8508, -76.2859,  1),
  ('DMA-630', 'Birmingham, AL',        33.5186, -86.8104,  1),
  ('DMA-518', 'Greensboro, NC',        36.0726, -79.7920,  1),
  ('DMA-650', 'Oklahoma City, OK',     35.4676, -97.5164,  1),
  ('DMA-790', 'Albuquerque, NM',       35.0844, -106.6504, 1),
  ('DMA-529', 'Louisville, KY',        38.2527, -85.7585,  1),
  ('DMA-622', 'New Orleans, LA',       29.9511, -90.0715,  1)
) AS source (dma_code, dma_name, lat, lng, base_concurrency)
ON target.dma_code = source.dma_code
WHEN MATCHED THEN
  UPDATE SET
    dma_name         = source.dma_name,
    lat              = source.lat,
    lng              = source.lng,
    updated_at       = GETDATE()
WHEN NOT MATCHED THEN
  INSERT (id, dma_code, dma_name, lat, lng, base_concurrency, is_active, created_at, updated_at)
  VALUES (
    LOWER(NEWID()),
    source.dma_code, source.dma_name, source.lat, source.lng,
    source.base_concurrency, 1, GETDATE(), GETDATE()
  );
