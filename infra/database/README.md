# CORE-TENANCY database boundary

This directory owns tenant operational migrations and the migration loader. The
provisioning account is used only by the setup path in
`packages/persistence/tenancy`; runtime pools receive a tenant-specific
directory entry and never receive control-plane credentials.

Traceability:

- SPECS §4.1–4.2: `TenantDirectoryEntry`, `createTenantContextFactory`, and
  `TenantPoolRegistry` keep tenant selection out of request data and bound
  pools by tenant and secret version.
- SPECS §5.2 and CORE-TENANCY acceptance: `provisionTenantDatabase` inventories
  MySQL 8 before creating the database/user, applies idempotent migrations, and
  only returns after a tenant-credentialed connection succeeds.
- Orchestrator CORE-TENANCY acceptance: migration files are synthetic and
  rerunnable; the API application service records `failed` and never promotes a
  failed provisioning attempt to `active`.

The repository's MySQL harness remains the evidence source for real-engine
isolation. No AWS resource or production database is used here.
