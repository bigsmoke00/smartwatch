import { Injectable, Logger } from '@nestjs/common';
import { request } from 'undici';

/**
 * Cliente fino para o Ansible Semaphore.
 *
 * Auth via SEMAPHORE_API_TOKEN (Authorization: Bearer ...) ou
 * via login com user/password (mantém cookie).
 *
 * Documentação: https://docs.ansible-semaphore.com/api-docs
 */
@Injectable()
export class SemaphoreClient {
  private readonly logger = new Logger('SemaphoreClient');
  private readonly base = (process.env.SEMAPHORE_URL || 'http://semaphore:3000').replace(/\/$/, '');
  private readonly token = process.env.SEMAPHORE_API_TOKEN || '';

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) h['authorization'] = `Bearer ${this.token}`;
    return h;
  }

  private async req(method: string, path: string, body?: any): Promise<any> {
    const url = `${this.base}/api${path}`;
    const res = await request(url, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      throw new Error(`Semaphore ${method} ${path} → ${res.statusCode}: ${text.slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  ping() {
    return this.req('GET', '/ping');
  }
  listProjects() {
    return this.req('GET', '/projects');
  }
  listTemplates(projectId: number) {
    return this.req('GET', `/project/${projectId}/templates`);
  }
  listInventory(projectId: number) {
    return this.req('GET', `/project/${projectId}/inventory`);
  }
  listTasks(projectId: number, limit = 50) {
    return this.req('GET', `/project/${projectId}/tasks/last?limit=${limit}`);
  }
  getTask(projectId: number, taskId: number) {
    return this.req('GET', `/project/${projectId}/tasks/${taskId}`);
  }
  getTaskOutput(projectId: number, taskId: number) {
    return this.req('GET', `/project/${projectId}/tasks/${taskId}/output`);
  }
  runTemplate(projectId: number, templateId: number, opts?: {
    debug?: boolean;
    dryRun?: boolean;
    environment?: string;
  }) {
    return this.req('POST', `/project/${projectId}/tasks`, {
      template_id: templateId,
      debug: opts?.debug ?? false,
      dry_run: opts?.dryRun ?? false,
      environment: opts?.environment ?? '',
    });
  }
  stopTask(projectId: number, taskId: number) {
    return this.req('POST', `/project/${projectId}/tasks/${taskId}/stop`);
  }
}
