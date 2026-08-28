import { handleDepartmentConversations } from './departmentConversations';
import { handleOpenAttendances } from './openAttendances';
import { handleConversations } from './conversations';
import baseWorker from './router';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BOOTSTRAP_SECRET?: string;
  RD_CONVERSAS_TOKEN?: string;
  RD_CONVERSAS_PRIVATE_JWK?: string;
  RD_CRM_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const departmentResponse = await handleDepartmentConversations(request, env);
    if (departmentResponse) return departmentResponse;

    const openAttendanceResponse = await handleOpenAttendances(request, env);
    if (openAttendanceResponse) return openAttendanceResponse;

    const conversationResponse = await handleConversations(request, env);
    if (conversationResponse) return conversationResponse;

    return baseWorker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
