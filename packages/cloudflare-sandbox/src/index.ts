import { Sandbox } from '@cloudflare/sandbox';
import { createExtensionProcessSandbox } from '@cloudflare/sandbox/extensions';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { SANDBOX_ID, SLEEP_AFTER_SECONDS, SandboxManagement, type ProvisionRequest, type NodeRecord } from './management';
export { ContainerProxy } from '@cloudflare/sandbox';

export interface Env {
  Sandbox: DurableObjectNamespace<NimbalystSandbox>;
}

export class NimbalystSandbox extends Sandbox<Env> {
  override sleepAfter = `${SLEEP_AFTER_SECONDS}s`;
  // Provisioning supplies a host allowlist; general internet access stays off.
  override enableInternet = false;
  // The pinned preview inherits false; HTTPS needs interception to reach the
  // host allowlist while unrestricted internet access remains disabled.
  override interceptHttps = true;
  // Arm interception (and CA injection) on the first wake, before provision()
  // supplies its hosts. An empty allowlist still denies every destination.
  override allowedHosts: string[] = [];
  // Inside a DO the core methods return RPC descriptors. This public SDK adapter
  // provides the same handle API as getSandbox(), without a self-RPC call.
  private readonly processes = createExtensionProcessSandbox(this);

  private readonly management = new SandboxManagement({
    getState: () => this.getState(),
    checkRuntime: async keepAlive => {
      await this.setSandboxName(SANDBOX_ID);
      await this.setKeepAlive(keepAlive);
      await this.setSleepAfter(SLEEP_AFTER_SECONDS);
      const process = await this.processes.exec(['/usr/local/bin/nimbalyst-node', '--smoke'], { timeout: 30_000 });
      const result = await process.output({ encoding: 'utf8', maxBytes: 4096 });
      if (result.exitCode !== 0 || result.timedOut) throw new Error('The sandbox started, but the headless node runtime check failed.');
    },
    stop: () => this.stop('SIGTERM'),
    node: {
      readRecord: () => this.ctx.storage.get<NodeRecord>('nimbalyst-node-process'),
      writeRecord: record => this.ctx.storage.put('nimbalyst-node-process', record),
      clearRecord: async () => { await this.ctx.storage.delete('nimbalyst-node-process'); },
      setAllowedHosts: hosts => this.setAllowedHosts(hosts),
      mkdir: path => this.mkdir(path, { recursive: true }),
      writeFile: (path, content) => this.writeFile(path, content),
      exec: (command, options) => this.processes.exec(command, options),
      exists: async path => (await this.exists(path)).exists,
      getProcess: id => this.processes.getProcess(id),
      listProcesses: () => this.processes.listProcesses(),
      setKeepAlive: value => this.setKeepAlive(value),
    },
  });

  managedStatus() { return this.management.status(); }
  managedWake() { return this.management.wake(); }
  managedStop(request: unknown) { return this.management.stop(request); }
  managedProvision(request: ProvisionRequest) { return this.management.provision(request); }
  managedStartNode(request: { configPath: string }) { return this.management.startNode(request); }
  managedNodeStatus() { return this.management.nodeStatus(); }
  managedStopNode(request: unknown) { return this.management.stopNode(request); }

}

NimbalystSandbox.outbound = async (request: Request) => {
  const response = await fetch(request);
  if (response.status !== 101 || !response.webSocket) return response;
  // The interception runtime emits these hop headers for the returned socket.
  // Forwarding them too produces "websocket, websocket" / "Upgrade, Upgrade",
  // which Node's WebSocket client rejects before opening the connection.
  const headers = new Headers(response.headers);
  headers.delete('upgrade');
  headers.delete('connection');
  return new Response(null, { status: 101, webSocket: response.webSocket, headers });
};

/** Available only through an account-authorized service binding, never HTTP. */
export class SandboxManager extends WorkerEntrypoint<Env> {
  status() { return this.env.Sandbox.getByName(SANDBOX_ID).managedStatus(); }
  wake() { return this.env.Sandbox.getByName(SANDBOX_ID).managedWake(); }
  stop(request: unknown) { return this.env.Sandbox.getByName(SANDBOX_ID).managedStop(request); }
  provision(request: ProvisionRequest) { return this.env.Sandbox.getByName(SANDBOX_ID).managedProvision(request); }
  startNode(request: { configPath: string }) { return this.env.Sandbox.getByName(SANDBOX_ID).managedStartNode(request); }
  nodeStatus() { return this.env.Sandbox.getByName(SANDBOX_ID).managedNodeStatus(); }
  stopNode(request: { discardEphemeralData: true }) { return this.env.Sandbox.getByName(SANDBOX_ID).managedStopNode(request); }
}

export default {
  fetch() { return new Response('Not found', { status: 404 }); },
} satisfies ExportedHandler<Env>;
