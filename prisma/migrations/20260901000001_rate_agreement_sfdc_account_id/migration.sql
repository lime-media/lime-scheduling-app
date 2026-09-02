-- Add sfdc_account_id to rate agreements for direct Salesforce Account linking.
-- Replaces the indirect partner_id → ClientUser.partner_id lookup.

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
    DISABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;

IF COL_LENGTH('dbo.app_rate_agreements', 'sfdc_account_id') IS NULL
    ALTER TABLE dbo.app_rate_agreements ADD sfdc_account_id NVARCHAR(1000) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_app_rate_agreements_sfdc_account_id' AND object_id = OBJECT_ID('dbo.app_rate_agreements'))
    CREATE INDEX IX_app_rate_agreements_sfdc_account_id ON dbo.app_rate_agreements (sfdc_account_id);

-- Backfill: copy sfdc_account_id from linked ClientUser where partner_id matches
UPDATE ra
SET ra.sfdc_account_id = cu.sfdc_account_id
FROM dbo.app_rate_agreements ra
JOIN dbo.app_client_users cu ON cu.partner_id = ra.partner_id
WHERE ra.sfdc_account_id IS NULL AND cu.sfdc_account_id IS NOT NULL;

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
    ENABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
