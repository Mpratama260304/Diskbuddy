import { loadConfig } from './config.js';
import { createProxyServer } from './proxy.js';

try {
  const config = loadConfig();
  const server = createProxyServer(config);
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ event: 'listening', port: server.address().port,
      publicUrl: config.mapper.publicUrl.origin, upstream: config.mapper.upstream.origin,
      indexable: config.indexable, canonicalMode: config.canonicalMode }));
  });
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10000).unref();
    });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}