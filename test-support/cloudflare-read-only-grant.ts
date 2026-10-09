/**
 * Ruling 192 (F40-63): the scope Cloudflare's API MCP server
 * (`https://mcp.cloudflare.com/mcp`) granted Viberr's live `cloudflare-api`
 * sign-in on 2026-09-25, as the `org.mcp.oauth_connected` audit row recorded
 * it: 194 scopes, every one of them a read. It is Cloudflare's own
 * "read-only" consent template (the three bootstrap scopes `user:read`,
 * `offline_access`, `account:read`, then every `.read`, `.metadata_read`,
 * `.monitoring` and `.report` scope in its catalog), which its consent page
 * picks when the authorization request names no scope. A Builds API write on
 * it came back "10000: Authentication error".
 */
export const CLOUDFLARE_READ_ONLY_SCOPES: readonly string[] = [
  "user:read", "offline_access", "account:read", "access-acct.read", "access-app.read",
  "access-audit-log.read", "access-certificate.read", "access-custom-page.read",
  "access-device-posture.read", "access-group.read", "access-idp.read", "access-key.read", "access-org.read",
  "access-policy-test.read", "access-policy.read", "access-population.read", "access-saml-certificate.read",
  "access-scim-log.read", "access-service-token.read", "access-ssh-auditing.read", "access-tag.read",
  "access-users.read", "access.read", "account-analytics.read", "account-api-gateway.read",
  "account-custom-asset.read", "account-custom-error-rules.read", "account-custom-pages.read",
  "account-disable-esc.read", "account-dns-settings.read", "account-firewall-access-rules.read",
  "account-logs.read", "account-rule-lists.read", "account-rulesets.read",
  "account-security-center-insights.read", "account-settings.read", "account-ssl-and-certificates.read",
  "account-waf.read", "account-waiting-rooms.read", "address-maps.read", "agw.read",
  "ai-search.metadata_read", "ai-search.read", "ai.read", "aiaudit.read", "aig.metadata_read", "aig.read",
  "analytics.read", "api-gateway.read", "argotunnel.read", "artifacts.read", "bot-management-feedback.read",
  "bot-management.read", "browser-rendering.read", "cache-settings.read", "calls.read", "casb.read",
  "cf-agents.read", "challenge-widgets.read", "chinanetwork-steering.read", "cloud-connector.read",
  "cloud-email-security.read", "cloudchamber.read", "cloudforce-one.read", "config-settings.read",
  "connectivity-directory.read", "constellation.read", "containers.read", "custom-errors.read",
  "custom-pages.read", "d1.metadata_read", "d1.read", "ddos-botnet-feed.read", "ddos-protection.read",
  "dls.read", "dns-firewall.read", "dns-view.read", "dns.read", "domain-page-shield.read",
  "dynamic-redirect.read", "email-routing-account-rule.read", "email-routing-address.read",
  "email-routing-rule.read", "email-routing-suppression.read", "email-security-dmarcreports.read",
  "email-sending.read", "fbm.read", "field-extractor.read", "firewall-for-ai.read", "firewall-services.read",
  "flagship.read", "fraud-detection-pii.read", "fraud-detection.read", "fraud-feedback.read",
  "healthcheck.read", "http-applications.read", "http-ddos-managed-ruleset.read", "images.metadata_read",
  "images.read", "intel.read", "iot.read", "ip-prefix-bgp-on-demand.read", "ip-prefix.read",
  "l4-ddos-managed-ruleset.read", "load-balancers-account.read", "load-balancers.read",
  "load-balancing-monitors-and-pools.read", "logs.read", "magic-firewall.read", "magic-transit.read",
  "magic-wan.read", "managed-headers.read", "mass-url-redirects.read", "mcp-portals.read",
  "memberships.read", "messaging.metadata_read", "messaging.read", "moq.read", "notifications.read",
  "origin.read", "page-rules.read", "page-shield.read", "page.read", "pages.metadata_read",
  "payments-gateway.read", "pcaps-api.read", "pipelines.read", "precursor.read", "pubsub.read",
  "query-cache.read", "queues.metadata_read", "queues.read", "r2-catalog-sql.read", "r2-catalog.read",
  "radar.read", "rag.read", "realtime.read", "registrar-domains.read", "registrar-sandbox-domains.read",
  "reports-application-security-report.read", "request-tracer.read", "resource-library.read",
  "resource-sharing.read", "response-compression.read", "sanitize.read", "secrets-store.read",
  "select-configuration.read", "snippets.read", "ssl-and-certificates.read", "stream.metadata_read",
  "stream.read", "tag.read", "teams-cds-compute-account.read", "teams-connector-cloudflared.monitoring",
  "teams-connector-cloudflared.read", "teams-connector-warp.read", "teams-connectors.read", "teams-dex.read",
  "teams-networks.read", "teams-pii.read", "teams-resilience.read", "teams.read", "teams.report",
  "transform-rules.read", "trust-and-safety.read", "url-scanner.read", "user-details.read", "vectorize.read",
  "waiting-rooms.read", "web3-hostnames.read", "websearch.metadata_read", "websearch.read",
  "workers-ci.read", "workers-kv-storage.metadata_read", "workers-kv-storage.read",
  "workers-observability.read", "workers-r2-bucket-item.read", "workers-r2.metadata_read", "workers-r2.read",
  "workers-routes.read", "workers-scripts.read", "workers-tail.read", "workers_ai.metadata_read",
  "zaraz.read", "zone-access.read", "zone-custom-asset.read", "zone-disable-esc.read",
  "zone-dns-settings.read", "zone-security-center-insights.read", "zone-settings.read",
  "zone-transform-rules.read", "zone-versioning.read", "zone-waf.read", "zone.read",
];

/** The grant as the token reply names it: space-joined. */
export const CLOUDFLARE_READ_ONLY_GRANT = CLOUDFLARE_READ_ONLY_SCOPES.join(" ");
