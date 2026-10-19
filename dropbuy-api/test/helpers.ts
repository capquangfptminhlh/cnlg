import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

export const FX = 'afa4cf0301eb4a75882dd5df30cc54a5';
let app: FastifyInstance | null = null;

export async function getApp() {
  if (!app) {
    app = await buildApp();
    await app.ready();
  }
  return app;
}

export type Res = { status: number; body: { success: boolean; error_code: number; message: string; data: any } };

export async function call(method: string, url: string, payload?: unknown, token?: string): Promise<Res> {
  const a = await getApp();
  const r = await a.inject({ method: method as 'GET', url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: r.json() };
}

/** Gọi và assert success, trả về data. */
export async function okCall(method: string, url: string, payload?: unknown, token?: string) {
  const r = await call(method, url, payload, token);
  if (!r.body.success) throw new Error(`${method} ${url} → ${r.status} ${r.body.error_code} ${r.body.message}`);
  return r.body.data;
}

const tokens = new Map<string, string>();
export async function login(username: string, password = '123456') {
  if (tokens.has(username)) return tokens.get(username)!;
  const d = await okCall('POST', '/bff/auth/login', { username, password });
  tokens.set(username, d.access_token);
  return d.access_token as string;
}
