import { execSync } from 'node:child_process';

// DB test riêng: reset schema + seed trước mỗi lần chạy bộ test.
export default function setup() {
  const env = { ...process.env, DATABASE_URL: 'file:./test.db', DEFAULT_TENANT_FX_HASH: 'afa4cf0301eb4a75882dd5df30cc54a5' };
  execSync('npx prisma db push --force-reset --skip-generate', { env, stdio: 'ignore' });
  execSync('npx tsx scripts/seed.ts', { env, stdio: 'ignore' });
}
