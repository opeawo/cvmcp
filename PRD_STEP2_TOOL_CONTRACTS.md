# PRD Step 2: Tool Contracts (.cv Domains ChatGPT App)

## 1) `check_domain`
Purpose: Check if a `.cv` domain is available.

Input:
- `domain` (string, required): with or without `.cv`

Output:
- `domain` (string)
- `available` (boolean)
- `raw` (object): full Ola response for debugging

Permissions:
- Read-only (`readOnlyHint=true`)

## 2) `register_domain`
Purpose: Register a `.cv` domain after explicit user confirmation.

Input:
- `domain` (string, required)
- `registrant_contact_id` (string, required)
- `years` (int, optional, default 1)
- `auto_renew` (boolean, optional, default false)
- `confirm_purchase` (boolean, required)

Output:
- `domain` (string)
- `status` = `registered`
- `raw` (object)

Permissions:
- Write (`readOnlyHint=false`)
- Bounded write (`openWorldHint=false`)
- Non-destructive (`destructiveHint=false`)

Confirmation flow:
- If `confirm_purchase=false`, tool must not register and should return `requires_confirmation=true`.

## 3) `list_domains`
Purpose: List current user domains.

Input:
- none

Output:
- `count` (number)
- `domains` (array)
- `raw` (object)

Permissions:
- Read-only (`readOnlyHint=true`)

## 4) `renew_domain`
Purpose: Renew an owned domain after explicit user confirmation.

Input:
- `domain` (string, required)
- `years` (int, optional, default 1)
- `confirm_renewal` (boolean, required)

Output:
- `domain` (string)
- `status` = `renewed`
- `raw` (object)

Permissions:
- Write (`readOnlyHint=false`)
- Bounded write (`openWorldHint=false`)
- Non-destructive (`destructiveHint=false`)

Confirmation flow:
- If `confirm_renewal=false`, do not renew and return `requires_confirmation=true`.

## 5) `update_dns`
Purpose: Update domain nameservers.

Input:
- `domain` (string, required)
- `nameservers` (string[], required, min 2)
- `confirm_dns_update` (boolean, required)

Output:
- `domain` (string)
- `nameservers` (string[])
- `status` = `updated`
- `raw` (object)

Permissions:
- Write (`readOnlyHint=false`)
- Bounded write (`openWorldHint=false`)
- Non-destructive (`destructiveHint=false`)

Confirmation flow:
- If `confirm_dns_update=false`, do not update and return `requires_confirmation=true`.
