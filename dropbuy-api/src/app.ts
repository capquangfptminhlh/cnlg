import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { ApiError } from './lib/http.js';
import { modules } from './modules/index.js';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 10 * 1024 * 1024,
    // Hỗ trợ cả tiền tố /api/proxy/bff/* giống FE gốc
    rewriteUrl: (req) => (req.url?.startsWith('/api/proxy/bff/') ? req.url.slice('/api/proxy'.length) : req.url ?? '/'),
  });

  // CORS đơn giản cho FE chạy domain khác (Next.js proxy gốc dùng /api/proxy/bff/*)
  app.addHook('onRequest', async (req, reply) => {
    reply.header('access-control-allow-origin', req.headers.origin ?? '*');
    reply.header('access-control-allow-credentials', 'true');
    reply.header('access-control-allow-headers', 'authorization,content-type,x-client-id,x-tenant-fx-hash');
    reply.header('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ success: false, error_code: err.error_code, message: err.message, data: null });
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') return reply.code(409).send({ success: false, error_code: 2009, message: 'Dữ liệu bị trùng', data: null });
      if (err.code === 'P2025') return reply.code(404).send({ success: false, error_code: 2004, message: 'Dữ liệu không tồn tại', data: null });
    }
    // Thiếu/ sai kiểu trường bắt buộc (vd id = NaN) → lỗi dữ liệu vào, không phải lỗi hệ thống
    if (err instanceof Prisma.PrismaClientValidationError) {
      const field = /Argument `(\w+)`/.exec(err.message)?.[1];
      return reply.code(400).send({ success: false, error_code: 2001, message: field ? `Trường ${field} thiếu hoặc không hợp lệ` : 'Dữ liệu đầu vào không hợp lệ', data: null });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ success: false, error_code: status >= 500 ? 5000 : 2000, message: status >= 500 ? 'Lỗi hệ thống' : err.message, data: null });
  });

  app.get('/health', async () => ({ ok: true }));

  const openapi = new URL('../contract/openapi.json', import.meta.url);
  app.get('/openapi.json', async (_req, reply) => {
    if (!existsSync(openapi)) return reply.code(404).send({ message: 'Chạy npm run contract:openapi trước' });
    return reply.type('application/json').send(readFileSync(openapi, 'utf8'));
  });

  for (const m of modules) m(app);
  return app;
}
