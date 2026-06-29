// Tool registry stub — V1.5 will populate this.
// WHY stub: the MCP dispatch infrastructure is wired in V1.2; actual tool
// implementations land in V1.5 once the deploy engine (V1.4) is ready.

import type { ToolDef } from "./mcp-dispatch.ts"

// V1.5 tools to add here:
//   provision_ct     — wrap utils pve create-ct; provision a new LXC service
//   bind_service     — dns + caddy wiring for a service
//   unbind_service   — cascade destroy: caddy/dns/forward/LXC
//   deploy           — manual: ssh target LXC → git pull → build → systemctl restart → health poll
//   rollback         — checkout previous SHA + restart + health poll
//   status           — show current/previous SHA, health, deploy log tail
//   list_services    — enumerate services from keel.services table
//   logs             — stream per-deployment logs (unguessable token auth in V2)
//   set_secret       — store secret key name only; value goes to LXC env_file via sops/scp
//   list_secret_keys — list key names for a service (values NEVER returned)
//   destroy_service  — requires confirm:true; cascade destroy

export const TOOLS: ToolDef[] = []
