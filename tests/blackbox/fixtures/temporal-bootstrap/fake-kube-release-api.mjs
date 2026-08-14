import fs from 'node:fs';
import http from 'node:http';

const [statePath, readyPath, logPath] = process.argv.slice(2);
if (!statePath || !readyPath || !logPath) {
  throw new Error('usage: fake-kube-release-api.mjs STATE READY LOG');
}

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const server = http.createServer((request, response) => {
  fs.appendFileSync(logPath, `${request.method} ${request.url}\n`);
  const url = new URL(request.url, 'http://127.0.0.1');

  if (request.method === 'GET' && url.pathname === '/version') {
    send(response, 200, {
      major: '1',
      minor: '31',
      gitVersion: 'v1.31.0',
      gitCommit: 'blackbox',
      gitTreeState: 'clean',
      buildDate: '2026-08-14T00:00:00Z',
      goVersion: 'go1.24',
      compiler: 'gc',
      platform: 'linux/amd64',
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api') {
    send(response, 200, { kind: 'APIVersions', apiVersion: 'v1', versions: ['v1'] });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/apis') {
    send(response, 200, { kind: 'APIGroupList', apiVersion: 'v1', groups: [] });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/v1') {
    send(response, 200, {
      kind: 'APIResourceList',
      apiVersion: 'v1',
      groupVersion: 'v1',
      resources: [
        { name: 'secrets', singularName: 'secret', namespaced: true, kind: 'Secret', verbs: ['get', 'list'] },
      ],
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/openapi/v2') {
    response.writeHead(200, {
      'content-type': 'application/com.github.proto-openapi.spec.v2@v1.0+protobuf',
    });
    response.end(Buffer.alloc(0));
    return;
  }
  if (request.method === 'GET' && /\/api\/v1\/namespaces\/[^/]+\/secrets$/.test(url.pathname)) {
    send(response, 200, {
      kind: 'SecretList',
      apiVersion: 'v1',
      metadata: { resourceVersion: '1' },
      items: [state.secret],
    });
    return;
  }
  if (request.method === 'GET' && /\/api\/v1\/namespaces\/[^/]+\/secrets\/[^/]+$/.test(url.pathname)) {
    send(response, 200, state.secret);
    return;
  }

  send(response, 404, {
    kind: 'Status',
    apiVersion: 'v1',
    status: 'Failure',
    reason: 'NotFound',
    code: 404,
    message: `fake API does not implement ${request.method} ${url.pathname}`,
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  fs.writeFileSync(readyPath, JSON.stringify({ port: address.port }));
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
