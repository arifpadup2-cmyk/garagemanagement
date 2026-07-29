# Phase 9 — Security & Administration · ERP Audit & Remediation

**System:** VIWO Garage Management (Tecido)
**Scope:** User Management · Roles · Permissions · Branch Access · Company Access · Audit Logs · Approval Workflows · System Configuration · Backup & Recovery
**Date:** 2026-07-29

---

## 1. The Finding

There was **one hardcoded admin account** read from an environment variable, plus
technician PINs. Everyone who was not a technician held complete authority over
money, stock, master data and the books — through a single shared login.

That has two consequences a garage feels immediately:

- **"Who did this?" is unanswerable.** The audit log existed and was well built,
  but every entry said the same name.
- **There is no way to hire.** A storekeeper cannot be given stock duties
  without also being handed the chart of accounts and every customer's balance.

| # | Severity | Finding |
|---|---|---|
| S1 | **Critical** | No user accounts. One shared admin credential from `ADMIN_PASSWORD`. |
| S2 | **Critical** | No roles or permissions — authorisation was a binary `admin` / `tech` flag. |
| S3 | **High** | No way to deactivate a leaver; the only lever was changing the shared password. |
| S4 | **Medium** | No user-facing permission catalogue, so no way to see what a role could do. |
| S5 | **Medium** | Deleting a user (had it been possible) would have orphaned the audit trail. |

---

## 2. What Was Built

### Users and roles
`users` and `roles` tables. Passwords are **scrypt-hashed** with the same helper
already trusted for technician PINs, and the hash is stripped from every read —
list and single — leaving only a `hasPassword` flag.

Usernames are unique (case-insensitive), because two accounts sharing one makes
"who did this?" unanswerable again.

### 27 named permissions
Capabilities rather than a flag: `inventory.manage`, `sales.payment`,
`purchasing.approve`, `finance.manage`, `admin.users` and so on. `GET
/api/permissions` returns the catalogue grouped by module for a role editor.

### Six roles a garage actually has
Owner · Manager · Service Advisor · Storekeeper · Accountant · Technician,
seeded once at boot and editable afterwards. The permission sets are drawn from
how the jobs really divide: a Service Advisor can raise a job card and take a
payment but cannot post a journal; a Storekeeper can receive goods but cannot
price them; an Accountant can pay a supplier invoice but cannot receive one.

### Enforcement
`authorize()` now routes a user account through `authorizeUser()`, which maps
every route to the permission it needs and **denies by default** — the opposite
of the old model. Sub-actions carry their own requirement, so approving a
purchase order needs `purchasing.approve` even for someone who may raise one.

Refusals name the missing capability:
> *Your role does not allow this — it needs "Manage accounts and journals".*

### Deliberate design decisions

- **The environment admin stays.** It is the bootstrap account, so a garage can
  never lock itself out of its own system.
- **Users cannot be deleted, only deactivated.** Deleting one erases who did
  what; the delete guard says so and points at deactivation.
- **A built-in role, or a role someone still holds, cannot be deleted.**
- **Login failures are indistinguishable.** A wrong username and a wrong
  password return the identical message, so the login page cannot be used to
  enumerate accounts.

---

## 3. Test Cases

| # | Test | Result |
|---|---|---|
| 1 | The environment admin still works and holds all 27 permissions | ✅ |
| 2 | Six default roles seeded | ✅ |
| 3 | A user without a password is refused | ✅ |
| 4 | Storekeeper and Accountant accounts created | ✅ |
| 5 | **The password hash never leaves the server**, in list or single reads | ✅ |
| 6 | Duplicate username refused (409) | ✅ |
| 7 | Storekeeper logs in and receives 8 permissions, none of them finance | ✅ |
| 8 | **A wrong password and a wrong username return the identical message** | ✅ |
| 9 | An inactive account cannot log in | ✅ |
| 10 | Storekeeper **can** read stock | ✅ |
| 11 | Storekeeper **cannot** touch the chart of accounts — refusal names the capability | ✅ |
| 12 | Storekeeper **cannot** manage users | ✅ |
| 13 | Storekeeper **cannot** take a payment | ✅ |
| 14 | Accountant **can** reach finance but **cannot** receive goods | ✅ |
| 15 | A role with an unknown permission is refused | ✅ |
| 16 | A built-in role, and a role in use, cannot be deleted | ✅ |
| 17 | A user cannot be deleted — told to deactivate | ✅ |

---

## 4. Remaining Work

1. **Branch / company access is not implemented.** The scope names it; the
   system is currently single-branch and the field does not exist. It should be
   a `branchIds` array on the user plus a scope filter on every list query —
   a substantial change best done deliberately rather than bolted on here.
2. **The login screen still posts to `/api/login`.** The user-account path is
   built and proven at the API; the front end needs a combined login that tries
   the user table first and falls back to the bootstrap admin.
3. **Approval workflows** exist for purchase orders only. Thresholds ("orders
   over 5,000 need the owner") are not configurable.
4. **Backup is export-only.** There is no restore path and no scheduled backup.
5. **Password policy** — no minimum strength, expiry or self-service reset.
