-- Add extension_until column to hold requests.
-- Allows clients to request a specific date when extending a hold.
ALTER TABLE dbo.app_hold_requests ADD extension_until DATETIME2 NULL;
