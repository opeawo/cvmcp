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

## 6) `create_contact`
Purpose: Create a contact required for domain registration.

Input:
- `name` (string, required)
- `email` (string, required)
- `phone` (string, required)
- `fax` (string, optional)
- `organization` (string, optional)
- `address` (string, required)
- `city` (string, required)
- `state` (string, optional)
- `postcode` (string, required)
- `country` (string, required, ISO 2-letter)

Output:
- `contact` (object)
- `raw` (object)

Permissions:
- Write (`readOnlyHint=false`)

## 7) `list_contacts`
Purpose: List contacts on the account.

Input:
- `per_page` (int, optional)
- `page` (int, optional)

Output:
- `count` (number)
- `contacts` (array)
- `meta` (object)
- `raw` (object)

Permissions:
- Read-only (`readOnlyHint=true`)

## 8) `fetch_contact`
Purpose: Fetch one contact by id.

Input:
- `id` (string, required)

Output:
- `contact` (object)
- `raw` (object)

Permissions:
- Read-only (`readOnlyHint=true`)

## 9) `register_domain_with_contact`
Purpose: End-to-end workflow that resolves contact (existing or created) and registers domain.

Input:
- `domain` (string, required)
- `years` (int, optional)
- `auto_renew` (boolean, optional)
- `existing_contact_id` (string, optional)
- `contact` (object, optional, same shape as `create_contact`)
- `confirm_purchase` (boolean, required)

Output:
- `domain` (string)
- `status` = `registered`
- `contact_id` (string)
- `contact` (object)
- `raw` (object)

Permissions:
- Write (`readOnlyHint=false`)

Confirmation flow:
- If `confirm_purchase=false`, do not register and return `requires_confirmation=true`.
