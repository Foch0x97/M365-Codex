import { ApiError, ACCOUNT_STATUSES } from '@m365-codex/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { createAdminGuard } from '../gateway/auth.js';
import { TokenUnavailableError } from '../oauth/tokenManager.js';
import { InvalidStateTransitionError } from '../repo/accounts.js';
import { maskEmail } from '../util/redact.js';

/**
 * 账号与授权管理接口。所有响应都不含 Token。
 *
 * 添加账号只有一种方式：本网关自己的 PKCE 授权流程
 * （authorize-url → 浏览器登录 → callback）。
 */

const callbackSchema = z.object({
  callback: z.string().min(1, '回调地址不能为空'),
});

const statusSchema = z.object({
  status: z.enum(ACCOUNT_STATUSES),
});

function parseOrThrow<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw ApiError.badRequest(issue?.message ?? '请求体不合法', issue?.path.join('.') || undefined);
  }
  return result.data;
}

export function registerAccountRoutes(app: FastifyInstance, context: AppContext): void {
  const adminGuard = createAdminGuard(context);

  // ---- 授权流程 ----

  app.post('/admin/oauth/authorize-url', { preHandler: adminGuard }, async (_request, reply) => {
    const started = context.oauth.start();
    context.auditLogs.record({ actor: 'admin', action: 'oauth.authorize_url.create' });
    reply.code(201);
    return started;
  });

  app.post('/admin/oauth/callback', { preHandler: adminGuard }, async (request) => {
    const body = parseOrThrow(callbackSchema, request.body);
    const result = await context.oauth.complete(body.callback);
    context.auditLogs.record({
      actor: 'admin',
      action: result.existing ? 'account.reauthorized' : 'account.created',
      target: result.account.id,
      detail: { email: maskEmail(result.account.email), tid: result.account.tid },
    });
    return { account: result.account, existing: result.existing };
  });

  app.get('/admin/oauth/sessions', { preHandler: adminGuard }, async () => {
    return { pending: context.oauthSessions.countPending() };
  });

  // ---- 账号管理 ----

  app.get('/admin/accounts', { preHandler: adminGuard }, async () => {
    return { data: context.accounts.listViews() };
  });

  app.get<{ Params: { id: string } }>(
    '/admin/accounts/:id',
    { preHandler: adminGuard },
    async (request) => {
      const view = context.accounts.getView(request.params.id);
      if (view === undefined) throw ApiError.notFound('账号不存在');
      return view;
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/admin/accounts/:id/status',
    { preHandler: adminGuard },
    async (request) => {
      const body = parseOrThrow(statusSchema, request.body);
      const account = context.accounts.findById(request.params.id);
      if (account === undefined) throw ApiError.notFound('账号不存在');

      let view;
      try {
        view = context.accounts.setStatus(request.params.id, body.status);
      } catch (error) {
        if (error instanceof InvalidStateTransitionError) {
          throw ApiError.badRequest(error.message, 'status');
        }
        throw error;
      }

      context.auditLogs.record({
        actor: 'admin',
        action: 'account.status.change',
        target: view.id,
        detail: { from: account.status, to: view.status },
      });
      return view;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/accounts/:id/refresh',
    { preHandler: adminGuard },
    async (request) => {
      const account = context.accounts.findById(request.params.id);
      if (account === undefined) throw ApiError.notFound('账号不存在');

      try {
        await context.tokens.refresh(request.params.id);
      } catch (error) {
        if (error instanceof TokenUnavailableError) {
          const status = error.reason === 'reauth_required' ? 409 : 502;
          throw new ApiError({
            type: error.reason === 'reauth_required' ? 'permission_error' : 'upstream_error',
            status,
            message: error.message,
          });
        }
        throw error;
      }

      context.auditLogs.record({
        actor: 'admin',
        action: 'account.token.refresh',
        target: request.params.id,
      });
      // 返回视图而不是 Token——Token 永远不出网关
      return context.accounts.getView(request.params.id);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/accounts/:id',
    { preHandler: adminGuard },
    async (request) => {
      const account = context.accounts.findById(request.params.id);
      if (account === undefined) throw ApiError.notFound('账号不存在');
      context.accounts.remove(request.params.id);
      context.auditLogs.record({
        actor: 'admin',
        action: 'account.delete',
        target: request.params.id,
        detail: { email: maskEmail(account.email) },
      });
      return { deleted: true, id: request.params.id };
    },
  );
}
