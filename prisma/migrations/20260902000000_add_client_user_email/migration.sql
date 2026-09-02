-- Add email field to client users for cancel/notification emails
IF COL_LENGTH('dbo.app_client_users', 'email') IS NULL
    ALTER TABLE dbo.app_client_users ADD email NVARCHAR(255) NULL;
