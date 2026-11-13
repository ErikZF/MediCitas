# The purpose of this .md

**English** · [Español](database-comparison.es.md)

To establish the architectural decisión, of why we used RLS,
For this, the assignment requested to compare between strategies
that could guarantee the separation of the data between clinics,
the candidates were:

## Row Level Security

This is the choosen option, it avoids any colissions that clinics
could have. It tells the database engine to only show the rows
that are on the same clinic id that the current local clinic id.

This also applies to ALL querys, with RLS, they have
a CHECK quote, that denies any query that is not from
the same clinic.

## Discriminatory Column

This one is similar to the RLS, but not enforced by the postgresql engine,
in this case, discriminatory column is enforced in the ORM layer, setting each 
query to discriminate by one column, in this case, the discriminatory column
would be set by clinic_id.

This solution works like RLS, but it is not enforced at database engine level,
therefore, the responsability relies on the backend team to enforce,
but could reduce some of the load from the database, depending on how are
queries implement.

Overall, it is a valid solution, but it is not the one we would go for.

## Database per Tenant

Having a Database per Tenant, would have a big benefit, and some downsides, which are:

Benefits:
- Having a database assigned to each tenant is complete isolation
- Each case a clinic needs to scale traffic, the system allows to just scale this tenant
- Knowing how much to charge for each tenant is really easy, you just have to measure that tenant's database

Downsides:
- Having scripts to create each database could be troublesome at implementation
- The minimum memory for this system is quite high, as you need to create a docker instance,
  or create another .db file inside the same container and have context switches


## Taken Decision

We decided to only implement RLS, as it is enough to enforce security, while having the least performance lost.