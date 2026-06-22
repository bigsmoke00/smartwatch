/**
 * Templates de email da plataforma. HTML inline (sem CSS externo) para
 * compatibilidade com a maioria dos clientes de email.
 */

const ISO_NOTICE = `
  Esta plataforma e seu conteúdo são propriedade da <strong>SmartSpace</strong> e
  destinam-se exclusivamente ao uso de pessoas expressamente autorizadas, em
  conformidade com os controles de segurança da informação baseados na
  ISO/IEC 27001. As informações tratadas nesta plataforma são classificadas
  como confidenciais. O acesso não autorizado, o uso indevido, a divulgação,
  cópia ou distribuição destas credenciais ou de quaisquer informações aqui
  obtidas é estritamente proibido e pode configurar crime previsto em lei
  (incluindo, no Brasil, a Lei nº 12.737/2012 e a Lei Geral de Proteção de
  Dados — Lei nº 13.709/2018), sujeitando o infrator às sanções civis e
  criminais aplicáveis. Caso você tenha recebido este email por engano, não
  utilize o link abaixo e entre em contato imediatamente com a equipe de
  segurança da SmartSpace.
`;

const VPN_NOTICE = `
  <p style="font-size:12px;line-height:1.6;background:#fff7ed;border:1px solid #fdba74;border-radius:6px;padding:10px 14px;color:#9a3412;margin:0 0 24px;">
    <strong>Atenção:</strong> o acesso a esta plataforma só funciona com a VPN da SmartSpace
    conectada. Conecte-se à VPN antes de clicar no link acima — caso contrário, a página não vai
    carregar.
  </p>
`;

function layout(opts: { title: string; bodyHtml: string }): string {
  return `<!doctype html>
<html lang="pt-BR">
  <head><meta charset="utf-8" /></head>
  <body style="margin:0;padding:0;background:#0b0f14;font-family:Arial,Helvetica,sans-serif;color:#1f2933;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0b0f14;padding:32px 0;">
      <tr>
        <td align="center">
          <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="background:#0f172a;padding:20px 32px;">
                <span style="color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:.3px;">SmartSpace</span>
                <span style="color:#94a3b8;font-size:13px;"> &middot; LogWatch</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="font-size:18px;margin:0 0 16px;color:#0f172a;">${opts.title}</h1>
                ${opts.bodyHtml}
                <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
                <p style="font-size:11px;line-height:1.6;color:#94a3b8;margin:0;">
                  <strong>Aviso de confidencialidade (ISO/IEC 27001):</strong>${ISO_NOTICE}
                </p>
                <p style="font-size:11px;color:#cbd5e1;margin:16px 0 0;">
                  &copy; ${new Date().getFullYear()} SmartSpace. Todos os direitos reservados. Este é um email automático, não responda.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function passwordSetupTemplate(link: string, email: string): string {
  return layout({
    title: 'Defina sua senha de acesso',
    bodyHtml: `
      <p style="font-size:14px;line-height:1.6;margin:0 0 16px;">
        Uma conta foi criada para você (<strong>${escapeHtml(email)}</strong>) na plataforma
        <strong>SmartSpace LogWatch</strong>. Clique no botão abaixo para definir sua senha de
        acesso. Este link é de uso único e expira em 3 dias.
      </p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${link}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-size:14px;font-weight:bold;display:inline-block;">
          Definir minha senha
        </a>
      </p>
      <p style="font-size:12px;line-height:1.6;color:#64748b;margin:0 0 24px;">
        Se o botão não funcionar, copie e cole este link no navegador:<br/>
        <a href="${link}" style="color:#2563eb;">${link}</a>
      </p>
      ${VPN_NOTICE}
    `,
  });
}

export function passwordResetTemplate(link: string, email: string): string {
  return layout({
    title: 'Redefinição de senha solicitada',
    bodyHtml: `
      <p style="font-size:14px;line-height:1.6;margin:0 0 16px;">
        Foi solicitada a redefinição da senha da conta <strong>${escapeHtml(email)}</strong> na
        plataforma <strong>SmartSpace LogWatch</strong>. Clique no botão abaixo para escolher uma
        nova senha. Este link é de uso único e expira em 3 dias.
      </p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${link}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-size:14px;font-weight:bold;display:inline-block;">
          Redefinir minha senha
        </a>
      </p>
      <p style="font-size:12px;line-height:1.6;color:#64748b;margin:0 0 24px;">
        Se o botão não funcionar, copie e cole este link no navegador:<br/>
        <a href="${link}" style="color:#2563eb;">${link}</a>
      </p>
      ${VPN_NOTICE}
    `,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
