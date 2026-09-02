-- Merge HoldRequest fields into Hold table
-- All new columns are nullable — zero impact on existing code until writers are updated.

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
BEGIN
    DISABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
END

-- Client user link
IF COL_LENGTH('dbo.app_holds', 'client_user_id') IS NULL
    ALTER TABLE dbo.app_holds ADD client_user_id NVARCHAR(1000) NULL;

-- Pricing snapshot
IF COL_LENGTH('dbo.app_holds', 'pricing_tier') IS NULL
    ALTER TABLE dbo.app_holds ADD pricing_tier NVARCHAR(1000) NULL;

IF COL_LENGTH('dbo.app_holds', 'quoted_total') IS NULL
    ALTER TABLE dbo.app_holds ADD quoted_total FLOAT NULL;

IF COL_LENGTH('dbo.app_holds', 'daily_rate') IS NULL
    ALTER TABLE dbo.app_holds ADD daily_rate FLOAT NULL;

IF COL_LENGTH('dbo.app_holds', 'features') IS NULL
    ALTER TABLE dbo.app_holds ADD features NVARCHAR(MAX) NULL;

-- Campaign grouping
IF COL_LENGTH('dbo.app_holds', 'truck_count') IS NULL
    ALTER TABLE dbo.app_holds ADD truck_count INT NULL;

IF COL_LENGTH('dbo.app_holds', 'campaign_group_id') IS NULL
    ALTER TABLE dbo.app_holds ADD campaign_group_id NVARCHAR(1000) NULL;

-- Unified expiration
IF COL_LENGTH('dbo.app_holds', 'expires_at') IS NULL
    ALTER TABLE dbo.app_holds ADD expires_at DATETIME2 NULL;

-- Extension workflow
IF COL_LENGTH('dbo.app_holds', 'extension_reason') IS NULL
    ALTER TABLE dbo.app_holds ADD extension_reason NVARCHAR(MAX) NULL;

IF COL_LENGTH('dbo.app_holds', 'extension_until') IS NULL
    ALTER TABLE dbo.app_holds ADD extension_until DATETIME2 NULL;

-- Indexes
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_app_holds_campaign_group_id' AND object_id = OBJECT_ID('dbo.app_holds'))
    CREATE INDEX IX_app_holds_campaign_group_id ON dbo.app_holds (campaign_group_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_app_holds_client_user_id' AND object_id = OBJECT_ID('dbo.app_holds'))
    CREATE INDEX IX_app_holds_client_user_id ON dbo.app_holds (client_user_id);

-- Data backfill: enrich existing CLIENT holds from their linked HoldRequests
UPDATE h
SET h.client_user_id   = hr.client_user_id,
    h.pricing_tier     = hr.pricing_tier,
    h.quoted_total     = hr.quoted_total,
    h.daily_rate       = hr.daily_rate,
    h.features         = hr.features,
    h.truck_count      = hr.truck_count,
    h.campaign_group_id = hr.campaign_group_id,
    h.expires_at       = hr.expires_at,
    h.extension_reason = hr.extension_reason,
    h.extension_until  = hr.extension_until
FROM dbo.app_holds h
JOIN dbo.app_hold_requests hr
  ON hr.truck_number = h.truck_number
  AND hr.start_date  = h.start_date
  AND hr.end_date    = h.end_date
  AND hr.market      = h.market
  AND hr.status      IN ('APPROVED', 'EXTENSION_REQUESTED')
WHERE h.source = 'CLIENT';

-- Backfill expires_at from sfdc_hold_exp for Salesforce holds
UPDATE dbo.app_holds
SET expires_at = sfdc_hold_exp
WHERE source = 'SALESFORCE' AND sfdc_hold_exp IS NOT NULL AND expires_at IS NULL;

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
BEGIN
    ENABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
END
