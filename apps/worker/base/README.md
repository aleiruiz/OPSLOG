# Base tenant worker

`TenantJobDispatcher` resolves and validates tenant state before invoking a
handler or publishing an event. Missing and suspended tenants are dead-lettered
without publication. Retry timing is deterministic (`2^attempt` seconds), and
queue publishers must deduplicate by `eventId`.

The dispatcher exposes reconciliation through the durable outbox store. It
does not receive credentials in jobs; authorization context is resolved from
the tenant directory for each delivery.
