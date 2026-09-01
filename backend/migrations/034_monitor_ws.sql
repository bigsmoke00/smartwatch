-- Migration 034: adiciona o tipo de check 'ws' (WebSocket) ao monitor.
-- Idempotente: recria o CHECK do tipo incluindo 'ws'.
ALTER TABLE monitor_endpoints DROP CONSTRAINT IF EXISTS monitor_endpoints_type_check;
ALTER TABLE monitor_endpoints
  ADD CONSTRAINT monitor_endpoints_type_check
  CHECK (type IN ('http','tcp','udp','icmp','dns','tls','ws'));
