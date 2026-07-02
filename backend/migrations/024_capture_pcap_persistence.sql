-- Persistência das capturas: o .pcap agora fica salvo em disco (volume) por 7
-- dias, pra visualizar/baixar depois — antes a captura era só em tempo real e
-- o conteúdo se perdia se ninguém estivesse assistindo.
--
-- pcap_stored indica se ainda existe arquivo em disco pra essa sessão. A
-- retenção (CaptureService.purgeOldPcaps, de hora em hora) apaga o arquivo e
-- zera esta flag depois de 7 dias; a sessão continua no histórico.
ALTER TABLE capture_sessions
  ADD COLUMN IF NOT EXISTS pcap_stored boolean NOT NULL DEFAULT false;
