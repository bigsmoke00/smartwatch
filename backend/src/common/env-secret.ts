import { Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';

/**
 * Leitura de segredos vindos de env, SEM fallback hardcoded no código.
 *
 * Motivação: scanners (njsscan/semgrep) — e a boa prática — acusam qualquer
 * segredo literal no fonte (um valor fixo de fallback escrito ao lado da env).
 * Um default fixo é pior que não ter default: se a env não subir em produção,
 * o sistema roda com um segredo público e conhecido.
 *
 * Regras:
 *  - Env definida  -> usa o valor.
 *  - Produção sem a env -> LANÇA no boot (fail-fast). Não subimos com segredo default.
 *  - Fora de produção sem a env -> gera um valor efêmero ALEATÓRIO, cacheado por
 *    nome (consistente durante o processo, mas some no restart). Assim o dev roda
 *    sem colocar segredo literal no código.
 */
const cache = new Map<string, string>();
const logger = new Logger('EnvSecret');

export function requireSecret(name: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;

  const cached = cache.get(name);
  if (cached) return cached;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `Variável de ambiente obrigatória ausente: ${name}. ` +
        `Defina-a antes de iniciar o backend (não existe valor padrão).`,
    );
  }

  const ephemeral = randomBytes(32).toString('hex');
  cache.set(name, ephemeral);
  logger.warn(
    `${name} não definida — usando segredo efêmero de desenvolvimento ` +
      `(tokens/sessões não sobrevivem a um restart). NÃO use assim em produção.`,
  );
  return ephemeral;
}
