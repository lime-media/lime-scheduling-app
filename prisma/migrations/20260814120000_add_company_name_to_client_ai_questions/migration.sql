-- ============================================================
-- Add company_name to dbo.app_client_ai_questions
--
-- Denormalizes the client's company name onto each question row at write
-- time, so the table alone (no join to dbo.app_client_users) shows who
-- asked what — a plain SELECT * is enough. Existing rows are backfilled
-- from the current app_client_users mapping.
--
-- Run against Azure SQL using the same process as the other prisma/*.sql
-- scripts (see SETUP.md). Do NOT run via `prisma db push` / `prisma migrate
-- deploy`.
-- ============================================================

IF COL_LENGTH('dbo.app_client_ai_questions', 'company_name') IS NULL
BEGIN
    ALTER TABLE dbo.app_client_ai_questions
        ADD company_name NVARCHAR(1000) NOT NULL
            CONSTRAINT DF_app_client_ai_questions_company_name DEFAULT '';

    PRINT 'Added column: app_client_ai_questions.company_name';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_client_ai_questions.company_name';
END
GO

-- Separate batch — a column added by the ALTER TABLE above isn't visible to name
-- resolution until a new batch starts, so referencing it in the same batch fails
-- with "Invalid column name" even though the ALTER TABLE itself is fine.
-- Filtered to '' so this is safe to re-run without clobbering a real backfilled value.
UPDATE q
SET q.company_name = u.company_name
FROM dbo.app_client_ai_questions q
JOIN dbo.app_client_users u ON u.id = q.client_user_id
WHERE q.company_name = '';

PRINT 'app_client_ai_questions.company_name migration complete.';
