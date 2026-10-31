# Bill.com customers — discovery (sandbox, 2026-10-31)

Connection: "Sandbox Bill.com" (`31e82ed1-…`, gateway.stage.bill.com/connect), via `createBillcomClientForConnection(connectionId, orgId, { supabase })` and `client.request(path, init)`.

## Read-only
- Sandbox had **0 customers**. `GET /v3/customers` → `{ results: [...] }` (paging token key not seen with 0 rows; `max` param accepted).
- `filters=accountNumber:eq:…` → error "field [accountNumber] is not supported in filter field". **Matching must list all customers and match in memory.**
- `filters=archived:eq:true` works (list archived customers).

## Writes (user-approved; 3 ZZNEXUS customers, all archived afterwards)
Customer object keys: `id` (0cu…), `archived`, `name`, `contact {firstName,lastName}`, `email`, `phone`, `invoiceCurrency`, `accountType`, `accountNumber`, `billingAddress {line1,line2,city,stateOrProvince,zipOrPostalCode,country,countryName}`, `balance`, `hasBankAccount`, `authorizedToCharge`, `createdTime`, `updatedTime`. No CC/secondary email; no shipping address on the object.

| Probe | Result |
|---|---|
| `POST /v3/customers` (name, accountNumber, email, phone, billingAddress, contact) | 201-style OK, returns the object |
| `PATCH /v3/customers/{id}` `{email}` | OK, only that field changed |
| `PATCH` `{phone: ''}` | OK — phone removed (blank clears) |
| Create with duplicate **name** | **accepted** (no name uniqueness) |
| Create with duplicate **accountNumber** | **accepted** (no account-number uniqueness) |
| `POST /v3/customers/{id}/archive` / `/restore` | OK; `archived` true/false |

## Consequences / rulings
- Inactive = `archived: true` via the archive/restore endpoints (not a PATCH field).
- No CC field → invoice email CC is not pushed; UI notes it.
- Bill.com enforces no uniqueness → Nexus must check for an existing account number (incl. archived) before every create, and flag >1 match as needs_attention. "Name clash" handling is moot.
- Payload: name, email, phone, billingAddress{line1,line2,city,stateOrProvince,zipOrPostalCode,country}, accountNumber. Contact not sent (*my call*; not required by create? untested without it — Task 4 implementer to keep contact out and the live test confirms).
