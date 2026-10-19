import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ok, plain } from './http.js';

export type Req = FastifyRequest;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Handler = (req: Req, reply: FastifyReply) => Promise<unknown>;

/** Danh sách route đã đăng ký, để đối chiếu với contract (scripts/coverage.ts). */
export const registry: { method: Method; path: string }[] = [];

/** Đăng ký route /bff/...; handler trả về `data`, wrapper bọc envelope. */
export function route(app: FastifyInstance, method: Method, path: string, handler: Handler) {
  registry.push({ method, path });
  app.route({
    method,
    url: path,
    handler: async (req, reply) => {
      const data = await handler(req, reply);
      if (reply.sent) return reply;
      return ok(plain(data));
    },
  });
}

export type Body = Record<string, any>;
export const body = (req: Req): Body => (req.body && typeof req.body === 'object' ? (req.body as Body) : {});
export const query = (req: Req): Body => (req.query as Body) ?? {};
export const params = (req: Req): Record<string, string> => (req.params as Record<string, string>) ?? {};
/** Gộp query + body (nhiều endpoint gốc nhận filter ở cả hai). */
export const input = (req: Req): Body => ({ ...query(req), ...body(req) });

export const num = (v: unknown, name = 'giá trị') => {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || Number.isNaN(n)) throw Object.assign(new Error(`${name} không hợp lệ`), { statusCode: 400 });
  return n;
};
export const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v === undefined || v === null ? [] : [v as T]);
