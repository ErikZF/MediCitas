# Multi-tenancy strategy comparison

**English** · [Español](database-comparison.es.md)

Clinics share tables inside each service database. We compared application filters,
RLS and a database per tenant to choose how to isolate their data.

## Row Level Security

RLS is the chosen enforcement layer over the `clinic_id` discriminator. Tenant
policies filter rows using the transaction clinic, with role-specific exceptions
for platform administration and global catalogs.

`USING` controls row visibility; `WITH CHECK` validates inserted or updated rows.
Policies require verified context and a restricted SQL role. Superusers and
`BYPASSRLS` roles bypass RLS, so it is not protection against a compromised DB login.

## Discriminatory Column

With application-only discrimination, each query filters by `clinic_id`. The
application or ORM must include that predicate; the engine does not add it.

Application filters keep tenant selection visible in queries, but one omitted
filter can expose rows.

## Database per Tenant

A database per tenant separates data and adds operational work:

Benefits:
- Separate databases reduce accidental cross-tenant queries; access still depends on credentials and routing.
- A clinic can be moved to dedicated resources when its traffic requires them.
- Per-database metrics can help attribute storage and activity to a tenant.

Downsides:
- Having scripts to create each database could be troublesome at implementation
- Provisioning, migrations and backups multiply by tenant. Separate databases
  can share a PostgreSQL instance; they do not require a Docker container each.


A schema per tenant would separate table namespaces inside one database, but
would multiply DDL migrations and require schema routing for every clinic. We
discarded it to keep one schema per service.

## Taken Decision

We use `clinic_id` plus RLS in shared tables, with API permission checks and
transaction-local identity. This keeps one schema per service and enforces row
filtering in the engine. The cost is maintaining policies and initializing context
for each transaction. We do not claim the lowest performance cost. Database per
service is implemented; database per tenant is not.
