# PRD Step 3: Simplified Website Builder Tool Contracts (Single MCP)

## Product UX Principle
Users should experience a simple personal website builder in ChatGPT.

They should never need to know about:
- Vercel
- contacts
- DNS implementation details
- provider-specific IDs

## Account Model
- Exactly 1 website per ChatGPT user
- Exactly 1 `.cv` domain per ChatGPT user (or 1 active domain)
- All ownership resolved server-side from authenticated `chatgpt_user_id`

## User-Facing Tools (Model Callable)

### 1) `create_my_website`
Purpose: Create the user’s single website.

Input:
- `display_name` (string, required)
- `headline` (string, optional)
- `bio` (string, optional)
- `sections` (array/object, optional)
- `style` (enum, optional): `classic`, `modern`, `minimal`

Output:
- `status` (`created` | `already_exists`)
- `website_url` (string, preview/live platform URL)
- `message` (string)

Tool hints:
- `readOnlyHint=false`
- `openWorldHint=false`
- `destructiveHint=false`

Rules:
- If a site already exists, return `already_exists` and suggest `update_my_website`.

### 2) `update_my_website`
Purpose: Update content/style of the user’s website and publish changes.

Input:
- `headline` (string, optional)
- `bio` (string, optional)
- `sections` (array/object, optional)
- `style` (enum, optional)
- `confirm_update` (boolean, required)

Output:
- `status` (`updated`)
- `website_url` (string)
- `last_published_at` (string)

Tool hints:
- `readOnlyHint=false`
- `openWorldHint=false`
- `destructiveHint=false`

Rules:
- Require `confirm_update=true` before mutating.

### 3) `set_my_domain`
Purpose: Register/connect user’s `.cv` domain to their website in one flow.

Input:
- `domain` (string, required)
- `contact` (object, required):
  - `name`
  - `email`
  - `phone`
  - `address`
  - `city`
  - `state` (optional)
  - `postcode`
  - `country` (ISO2)
- `confirm_purchase` (boolean, required)

Output:
- `status` (`connected` | `pending`)
- `domain` (string)
- `live_url` (string)
- `message` (string)

Tool hints:
- `readOnlyHint=false`
- `openWorldHint=false`
- `destructiveHint=false`

Rules:
- Internally: create/fetch contact, register domain, configure hosting, set DNS.
- Do not expose provider-specific identifiers in model output.

### 4) `publish_my_website`
Purpose: Publish current website state and verify reachability.

Input:
- `confirm_publish` (boolean, required)

Output:
- `status` (`published` | `pending_dns` | `error`)
- `website_url` (string)
- `domain_url` (string, optional)
- `message` (string)

Tool hints:
- `readOnlyHint=false`
- `openWorldHint=false`
- `destructiveHint=false`

Rules:
- Internally handles build/deploy/attach-domain silently.

### 5) `my_website_status`
Purpose: Show simple health/status of user website and domain.

Input:
- none

Output:
- `website_exists` (boolean)
- `website_url` (string, optional)
- `domain` (string, optional)
- `domain_connected` (boolean)
- `ssl_ready` (boolean)
- `last_published_at` (string, optional)
- `message` (string)

Tool hints:
- `readOnlyHint=true`
- `openWorldHint=false`
- `destructiveHint=false`

### 6) `delete_my_website` (optional)
Purpose: Archive/reset user website.

Input:
- `confirm_delete` (boolean, required)

Output:
- `status` (`deleted`)
- `message` (string)

Tool hints:
- `readOnlyHint=false`
- `openWorldHint=false`
- `destructiveHint=true`

Rules:
- Require explicit confirmation every time.

## Internal-Only Tools (Not Model Callable)
These are allowed in backend orchestration but hidden from the model/user interface.

- Ola internals:
  - `create_contact`
  - `fetch_contact`
  - `list_contacts`
  - `register_domain`
  - `update_dns`
  - `list_domains`
- Hosting internals:
  - provider deploy/create-project/status tools

Visibility policy:
- Set internal tools to app-only visibility (not model-visible).
- Expose only user-facing tools listed above.

## Data Model (Minimal)
- `users`
  - `chatgpt_user_id` (PK)
- `websites`
  - `chatgpt_user_id` (unique)
  - `content_json`
  - `hosting_project_id` (internal)
  - `website_url`
  - `last_published_at`
  - `status`
- `domains`
  - `chatgpt_user_id` (unique)
  - `domain`
  - `contact_id` (internal)
  - `registry_domain_id` (internal)
  - `status`

## Safety and Reliability
- Idempotency keys for paid/mutating steps
- Ownership checks on every write
- No secrets in outputs/logs
- Human-readable errors only
- Audit log for write actions

## Canonical User Journeys
1. "Build my personal website"
- `create_my_website`
- `publish_my_website`

2. "Set my domain to jane.cv"
- `set_my_domain`
- internally creates contact/registers/connects

3. "Update my bio"
- `update_my_website`
- `publish_my_website`

4. "Is my site live?"
- `my_website_status`
