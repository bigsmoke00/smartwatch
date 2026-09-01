-- 038: adiciona 'teams' (Teams / Power Automate via MessageCard) aos tipos de canal de notificacao.
-- A constraint original (001_init.sql) tem nome auto-gerado notification_channels_kind_check.
-- Sem esse ALTER, INSERT de kind='teams' viola o CHECK e o backend retorna 500.

ALTER TABLE notification_channels DROP CONSTRAINT IF EXISTS notification_channels_kind_check;

ALTER TABLE notification_channels
  ADD CONSTRAINT notification_channels_kind_check
  CHECK (kind IN ('slack','discord','webhook','email','pagerduty','telegram','teams'));
