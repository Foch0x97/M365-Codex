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

// 契约文档（§一）写的入参是 `{redirect_url}` 或 `{code, state}`；早期实现用的是
// `{callback}`。三种都收——`callback`/`redirect_url` 同义（都是完整回调地址或裸查询串），
// `{code, state}` 则是 WebUI 自己从回调地址里拆出来又传回来的形态，这里拼回等价的查询串，
// 复用同一套 `parseCallback` 解析逻辑，不建第二套解析代码。
const callbackSchema = z
  .object({
    callback: z.string().min(1).optional(),
    redirect_url: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
  })
  .transform((value, ctx) => {
    if (value.callback !== undefined) return value.callback;
    if (value.redirect_url !== undefined) return value.redirect_url;
    if (value.code !== undefined && value.state !== undefined) {
      return `code=${encodeURIComponent(value.code)}&state=${encodeURIComponent(value.state)}`;
    }
    ctx.addIssue({
      code: 'custom',
      message: '请提供 callback、redirect_url，或 code + state',
    });
    return z.NEVER;
  });

const statusSchema = z.object({
  status: z.enum(ACCOUNT_STATUSES),
});

// 契约文档只用到了 status，但 PATCH /admin/accounts/:id 是通用入口，
// 预留了以后可能追加的可改字段（display_name 等）不至于推翻这条路由。
const patchAccountSchema = z
  .object({
    status: z.enum(ACCOUNT_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要提供一个待更新字段' });

const proxyBindingSchema = z.object({
  proxy_id: z.string().min(1).nullable(),
});

function parseOrThrow<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw ApiError.badRequest(issue?.message ?? '请求体不合法', issue?.path.join('.') || undefined);
  }
  return result.data;
}

/** 解析结果不是 `z.ZodType<T>`（有 `.transform`）时用这个，逻辑与 `parseOrThrow` 一致。 */
function parseTransformedOrThrow<Output>(
  schema: { safeParse: (payload: unknown) => z.SafeParseReturnType<unknown, Output> },
  payload: unknown,
): Output {
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
    const callback = parseTransformedOrThrow(callbackSchema, request.body);
    const result = await context.oauth.complete(callback);
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

  function changeStatus(accountId: string, status: (typeof ACCOUNT_STATUSES)[number]): ReturnType<typeof context.accounts.setStatus> {
    const account = context.accounts.findById(accountId);
    if (account === undefined) throw ApiError.notFound('账号不存在');

    let view;
    try {
      view = context.accounts.setStatus(accountId, status);
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
  }

  app.patch<{ Params: { id: string } }>(
    '/admin/accounts/:id/status',
    { preHandler: adminGuard },
    async (request) => {
      const body = parseOrThrow(statusSchema, request.body);
      return changeStatus(request.params.id, body.status);
    },
  );

  // 契约文档 §一「已存在」列出的是 PATCH /admin/accounts/:id（不带 /status 后缀）；
  // 保留上面那条 /status 路由不动（避免破坏既有测试与调用方），这里补一条按契约
  // 命名的通用入口，当前只支持改 status，字段名与语义完全对齐 /status 那条。
  app.patch<{ Params: { id: string } }>(
    '/admin/accounts/:id',
    { preHandler: adminGuard },
    async (request) => {
      const body = parseOrThrow(patchAccountSchema, request.body);
      if (body.status === undefined) {
        // 目前唯一支持的字段是 status；理论上不会走到这里（schema 已要求至少一项），
        // 但显式报错比静默返回原样更诚实
        throw ApiError.badRequest('当前只支持更新 status 字段', 'status');
      }
      return changeStatus(request.params.id, body.status);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/accounts/:id/proxy',
    { preHandler: adminGuard },
    async (request) => {
      const body = parseOrThrow(proxyBindingSchema, request.body);
      const account = context.accounts.findById(request.params.id);
      if (account === undefined) throw ApiError.notFound('账号不存在');

      if (body.proxy_id !== null && context.proxyNodes.findById(body.proxy_id) === undefined) {
        throw ApiError.badRequest('代理节点不存在', 'proxy_id');
      }

      const view = context.accounts.setProxyNode(request.params.id, body.proxy_id);
      if (view === undefined) throw ApiError.notFound('账号不存在');

      context.auditLogs.record({
        actor: 'admin',
        action: 'account.proxy.bind',
        target: request.params.id,
        detail: { proxy_id: body.proxy_id },
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
