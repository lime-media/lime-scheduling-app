-- Add Salesforce Account ID to client users for outbound opportunity creation.
ALTER TABLE dbo.app_client_users ADD sfdc_account_id NVARCHAR(255) NULL;

-- Add Salesforce Opportunity ID to hold requests for outbound sync tracking.
ALTER TABLE dbo.app_hold_requests ADD sfdc_opportunity_id NVARCHAR(255) NULL;

-- Link testclient to the Lime Media Salesforce Account.
UPDATE dbo.app_client_users SET sfdc_account_id = '001f200001g5AnEAAU' WHERE username = 'testclient';
