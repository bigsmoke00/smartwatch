import { Injectable, Logger } from '@nestjs/common';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { passwordResetTemplate, passwordSetupTemplate } from './mail-templates';

/**
 * Envio de email via AWS SES. Credenciais:
 *   - se AWS_SES_ACCESS_KEY_ID/SECRET estiverem definidos, usa essas;
 *   - caso contrário, cai no provider chain padrão da AWS (IAM role da
 *     instância/task, útil em ECS/EC2 com a permissão ses:SendEmail já
 *     anexada).
 * O remetente (MAIL_FROM) precisa estar verificado no SES (ou o domínio,
 * se a conta já estiver fora do sandbox).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('MailService');

  private readonly client = new SESClient({
    region: process.env.AWS_SES_REGION || process.env.AWS_REGION || 'us-east-1',
    ...(process.env.AWS_SES_ACCESS_KEY_ID
      ? {
          credentials: {
            accessKeyId: process.env.AWS_SES_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SES_SECRET_ACCESS_KEY || '',
          },
        }
      : {}),
  });

  private readonly from = process.env.MAIL_FROM || 'no-reply@smartspace.us';
  private readonly fromName = process.env.MAIL_FROM_NAME || 'SmartSpace LogWatch';

  async send(to: string, subject: string, html: string): Promise<boolean> {
    try {
      await this.client.send(
        new SendEmailCommand({
          Source: `${this.fromName} <${this.from}>`,
          Destination: { ToAddresses: [to] },
          Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: { Html: { Data: html, Charset: 'UTF-8' } },
          },
        }),
      );
      return true;
    } catch (e: any) {
      this.logger.error(`Falha ao enviar email para ${to}: ${e.message}`, e.stack);
      return false;
    }
  }

  async sendPasswordSetupEmail(to: string, link: string): Promise<boolean> {
    return this.send(
      to,
      'SmartSpace LogWatch — Defina sua senha de acesso',
      passwordSetupTemplate(link, to),
    );
  }

  async sendPasswordResetEmail(to: string, link: string): Promise<boolean> {
    return this.send(
      to,
      'SmartSpace LogWatch — Redefinição de senha',
      passwordResetTemplate(link, to),
    );
  }
}
