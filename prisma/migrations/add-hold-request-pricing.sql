-- Add pricing, expiration, and campaign grouping fields to app_hold_requests
-- Run against the production/UAT database manually.

ALTER TABLE app_hold_requests ADD pricing_tier NVARCHAR(255) NULL;
ALTER TABLE app_hold_requests ADD quoted_total FLOAT NULL;
ALTER TABLE app_hold_requests ADD daily_rate FLOAT NULL;
ALTER TABLE app_hold_requests ADD features NVARCHAR(MAX) NULL;
ALTER TABLE app_hold_requests ADD truck_count INT NULL;
ALTER TABLE app_hold_requests ADD campaign_group_id NVARCHAR(255) NULL;
ALTER TABLE app_hold_requests ADD expires_at DATETIME2 NULL;
ALTER TABLE app_hold_requests ADD extension_reason NVARCHAR(MAX) NULL;

-- Index for campaign group lookups
CREATE INDEX IX_app_hold_requests_campaign_group_id
    ON app_hold_requests (campaign_group_id)
    WHERE campaign_group_id IS NOT NULL;
