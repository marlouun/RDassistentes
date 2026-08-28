import { runBackgroundWalletSync } from './backgroundSync';
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
    const conversationResponse = await handleConversations(request, env);
    if (conversationResponse) return conversationResponse;
    return baseWorker.fetch(request, env);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      await runBackgroundWalletSync(env);
    } catch (error) {
      console.error('Background wallet sync failed.', error);
    }
  },
} satisfies ExportedHandler<Env>;
