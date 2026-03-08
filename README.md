# .cv Domains ChatGPT App (MCP)

MCP server for searching and managing `.cv` domains inside ChatGPT using Ola API.

## Implemented scope
- P0 flow: `check_domain` -> `register_domain`
- P1 management tools: `list_domains`, `renew_domain`, `update_dns`
- Contact tools: `create_contact`, `list_contacts`, `fetch_contact`
- Combined flow: `register_domain_with_contact` (contact + domain registration in one backend workflow)
- Simplified website-builder tools:
  - `create_my_website`
  - `set_website_react_source`
  - `set_website_html`
  - `update_my_website`
  - `publish_my_website`
  - `set_my_domain`
  - `my_website_status`

## API assumptions
Using Ola endpoints from your PRD:
- `POST /api/v1/domains/check`
- `POST /api/v1/domains/register`
- `GET /api/v1/domains`
- `POST /api/v1/domains/{domain}/renew`
- `POST /api/v1/domains/{domain}`

Auth header:
- `Authorization: Bearer <OLA_API_TOKEN>` (prefix configurable via `OLA_AUTH_PREFIX`)

## Setup
1. Install dependencies:
```bash
npm install
```

2. Configure env:
```bash
cp .env.example .env
```

3. Start server:
```bash
npm start
```

Server endpoints:
- MCP endpoint: `http://localhost:8787/mcp`
- Health: `http://localhost:8787/health`

## Environment Variables
Required now (domain + contact flows):
- `OLA_API_TOKEN`
- `OLA_API_BASE_URL` (default `https://developer.ola.cv`)
- `OLA_AUTH_PREFIX` (default `Bearer`)

Optional now:
- `PORT` (Railway injects this in production)
- `DEFAULT_REGISTRATION_YEARS`
- `DEFAULT_RENEWAL_YEARS`

Planned for managed website hosting integration:
- `VERCEL_TOKEN`
- `VERCEL_TEAM_ID`
- `VERCEL_PROJECT_NAME` (recommended: single shared project for all user domains)
- `VERCEL_PROJECT_PREFIX`
- `VERCEL_DEFAULT_REGION`

## Add to ChatGPT Developer Mode
1. Enable Developer Mode in ChatGPT (Settings -> Apps -> Advanced settings -> Developer mode).
2. Expose local server via HTTPS tunnel (for example `ngrok http 8787`).
3. Create App from MCP URL: `https://<your-tunnel>/mcp`.
4. Test prompts:
- `is john.cv available`
- `register john.cv`
- `show my domains`
- `renew john.cv`
- `show my contacts`
- `register john.cv with this contact ...`
- `create my website for Opeyemi Awoyemi`
- `set website react source ...`
- `publish my website`
- `set my domain to yourname.cv`
- `what is my website status`

## P0 conversation behavior
Expected interaction:
1. User: `Is john.cv available?`
2. App calls `check_domain`
3. Assistant asks: `Register john.cv for $12/year?`
4. User confirms
5. App calls `register_domain` with `confirm_purchase=true`

## Notes
- Write tools include MCP annotations for confirmation-oriented UX.
- Tool handlers also enforce explicit confirmation booleans (`confirm_purchase`, `confirm_renewal`, `confirm_dns_update`).
- Domain input is normalized to `.cv`.
