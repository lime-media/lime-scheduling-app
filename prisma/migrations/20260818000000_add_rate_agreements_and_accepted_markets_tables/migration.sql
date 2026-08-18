-- ============================================================
-- Add Self-Service Quoting tables — dbo.app_rate_agreements
-- and dbo.app_accepted_markets
--
-- Both models were added to schema.prisma in "Add self-service quoting
-- engine with transport pricing and rate agreements" (commit dfcb5c3c2),
-- alongside lib/pricing/ and POST /api/v1/internal/quote — but that
-- commit only touched schema.prisma, no migration was ever written.
-- Neither table exists in any real database yet. Until this runs,
-- /api/v1/internal/quote 500s any time it's called with partner_id (rate
-- agreement lookup) or campaign_lat/campaign_lng + lead_business_days
-- (accepted-market/transport lookup) — both prisma.rateAgreement and
-- prisma.acceptedMarket calls throw "Invalid object name" against a
-- table that isn't there.
--
-- partner_id on app_rate_agreements is a free string, not a foreign key —
-- same loose-reference convention already used for mcp_tokens/mcp_query_log
-- user_id ("target depends on user_type"). It's compared against the new
-- app_client_users.partner_id column (see the sibling migration
-- 20260818000100_add_partner_id_to_client_users) purely in application code.
--
-- Run against Azure SQL using the same process as the other prisma/*.sql
-- scripts (see SETUP.md). Do NOT run via `prisma db push` / `prisma
-- migrate deploy`.
--
-- NOTE: on a database cloned from production (e.g. limemediaprod_UAT), a leftover
-- Databricks Lakeflow CDC trigger (lakeflowDdlAuditTrigger_1_1) fires on DDL
-- statements including CREATE TABLE and tries a cross-database write back to
-- limemediaprod, which Azure SQL Database rejects (Msg 40515). It's disabled for
-- the duration of the statements below and re-enabled immediately after — same
-- guard as the other recent migrations on this table set. On real limemediaprod
-- this is a harmless no-op (same-database write there, works fine).
-- ============================================================

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
BEGIN
    DISABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
    PRINT 'Disabled trigger: lakeflowDdlAuditTrigger_1_1 (will re-enable at end of script)';
END

-- -------------------------------------------------------
-- app_rate_agreements: per-partner negotiated rate-card overrides
-- agreement_type: standard | volume_discount | flat_rate | custom
-- rate_overrides: JSON blob, selective overrides to the standard rate card
--                 (see lib/pricing/config.ts RateOverrides type)
-- -------------------------------------------------------
IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'app_rate_agreements'
)
BEGIN
    CREATE TABLE dbo.app_rate_agreements (
        id              NVARCHAR(1000) NOT NULL,
        partner_id      NVARCHAR(1000) NOT NULL,
        name            NVARCHAR(1000) NOT NULL,
        agreement_type  NVARCHAR(1000) NOT NULL CONSTRAINT DF_app_rate_agreements_agreement_type DEFAULT 'standard',
        effective_date  DATETIME2      NOT NULL,
        expiration_date DATETIME2      NOT NULL,
        rate_overrides  NVARCHAR(MAX)  NOT NULL,
        created_by      NVARCHAR(1000) NOT NULL,
        notes           NVARCHAR(MAX)  NULL,
        created_at      DATETIME2      NOT NULL CONSTRAINT DF_app_rate_agreements_created_at DEFAULT GETUTCDATE(),
        updated_at      DATETIME2      NOT NULL CONSTRAINT DF_app_rate_agreements_updated_at DEFAULT GETUTCDATE(),

        CONSTRAINT PK_app_rate_agreements PRIMARY KEY (id)
    );

    -- Matches the lookup pattern in app/api/v1/internal/quote/route.ts and
    -- lib/clientChatContext-adjacent quote code: WHERE partner_id = ? AND
    -- effective_date <= now AND expiration_date >= now ORDER BY created_at DESC
    CREATE INDEX IX_app_rate_agreements_partner_dates
        ON dbo.app_rate_agreements (partner_id, effective_date, expiration_date);

    PRINT 'Created table: dbo.app_rate_agreements';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.app_rate_agreements';
END

-- -------------------------------------------------------
-- app_accepted_markets: operational bases (top-50 DMAs) — any campaign
-- city within 450 miles (SERVICE_AREA_RADIUS_MILES) of one of these is
-- inside the transport-included inclusion zone. Seeded separately via
-- prisma/seed-accepted-markets.ts — this migration only creates the table.
-- -------------------------------------------------------
IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'app_accepted_markets'
)
BEGIN
    CREATE TABLE dbo.app_accepted_markets (
        id               NVARCHAR(1000) NOT NULL,
        dma_code         NVARCHAR(1000) NOT NULL,
        dma_name         NVARCHAR(1000) NOT NULL,
        lat              FLOAT          NOT NULL,
        lng              FLOAT          NOT NULL,
        base_concurrency INT            NOT NULL CONSTRAINT DF_app_accepted_markets_base_concurrency DEFAULT 1,
        notes            NVARCHAR(MAX)  NULL,
        is_active        BIT            NOT NULL CONSTRAINT DF_app_accepted_markets_is_active DEFAULT 1,
        created_at       DATETIME2      NOT NULL CONSTRAINT DF_app_accepted_markets_created_at DEFAULT GETUTCDATE(),
        updated_at       DATETIME2      NOT NULL CONSTRAINT DF_app_accepted_markets_updated_at DEFAULT GETUTCDATE(),

        CONSTRAINT PK_app_accepted_markets PRIMARY KEY (id),
        CONSTRAINT UQ_app_accepted_markets_dma_code UNIQUE (dma_code)
    );

    PRINT 'Created table: dbo.app_accepted_markets';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.app_accepted_markets';
END

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
BEGIN
    ENABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
    PRINT 'Re-enabled trigger: lakeflowDdlAuditTrigger_1_1';
END

PRINT 'Self-service quoting tables migration complete.';
