try {
  process.loadEnvFile();
} catch {
  /* không có .env – dùng biến môi trường sẵn có */
}
const { buildApp } = await import('./app.js');

const app = await buildApp({ logger: true });
const port = Number(process.env.PORT || 4000);
await app.listen({ port, host: '0.0.0.0' });
