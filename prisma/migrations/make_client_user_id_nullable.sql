-- Make client_user_id nullable on hold requests so internal holds
-- (placed by staff via the quote builder) don't require a ClientUser.

-- Drop the existing FK constraint first
ALTER TABLE dbo.app_hold_requests DROP CONSTRAINT FK_app_hold_requests_client_user;

-- Make the column nullable
ALTER TABLE dbo.app_hold_requests ALTER COLUMN client_user_id NVARCHAR(1000) NULL;

-- Re-add the FK constraint allowing NULLs
ALTER TABLE dbo.app_hold_requests ADD CONSTRAINT FK_app_hold_requests_client_user
  FOREIGN KEY (client_user_id) REFERENCES dbo.app_client_users(id) ON DELETE NO ACTION ON UPDATE NO ACTION;
