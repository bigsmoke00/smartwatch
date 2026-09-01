-- Migration 037: novos tipos de check no monitor — ssh, starttls, domain.
-- Idempotente.
ALTER TABLE monitor_endpoints DROP CONSTRAINT IF EXISTS monitor_endpoints_type_check;
ALTER TABLE monitor_endpoints
  ADD CONSTRAINT monitor_endpoints_type_check
  CHECK (type IN ('http','tcp','udp','icmp','dns','tls','ws','ssh','starttls','domain'));
