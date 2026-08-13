import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Local Connector control plane architecture', () => {
  it('keeps session ownership and Bridge orchestration out of the route adapter', () => {
    const route = source('src/server/routes/api/localConnector.ts');
    const controlPlane = source('src/server/services/localConnectorControlPlaneService.ts');
    const activity = source('src/server/services/localConnectorThreadActivityService.ts');

    expect(route).toContain("from '../../services/localConnectorControlPlaneService.js'");
    expect(route).toContain("from '../../services/localConnectorThreadActivityService.js'");
    expect(route).toContain('takeOverLocalConnectorThread({');
    expect(route).toContain('getLocalConnectorThreadActivity({');
    expect(route).not.toMatch(/from ['"]\.\.\/\.\.\/db\//);
    expect(route).not.toContain('createBridgeContinuationTask({');

    expect(controlPlane).toContain('schema.localConnectorThreads');
    expect(controlPlane).toContain('createBridgeContinuationTask({');
    expect(controlPlane).toContain("requireActiveLocalConnectorDevice(deviceId, 'app_server.control')");

    expect(activity).toContain('schema.bridgeContinuationEvents');
    expect(activity).toContain('schema.interactionEvents');
    expect(activity).toContain('schema.interactionDispatches');
    expect(activity).toContain('schema.notificationOutbox');
  });

  it('keeps global continuation reconciliation in a dedicated service and scheduler', () => {
    const route = source('src/server/routes/api/bridgeContinuations.ts');
    const coordinator = source('src/server/services/globalBridgeContinuationService.ts');
    const scheduler = source('src/server/services/globalBridgeContinuationScheduler.ts');
    const threadService = source('src/server/services/localConnectorThreadService.ts');

    expect(route).toContain("from '../../services/globalBridgeContinuationService.js'");
    expect(route).not.toMatch(/from ['"]\.\.\/\.\.\/db\//);
    expect(coordinator).toContain('schema.localConnectorThreads');
    expect(coordinator).toContain('takeOverLocalConnectorThread({');
    expect(scheduler).toContain('reconcileGlobalBridgeContinuationTasks()');
    expect(scheduler).not.toContain('schema.');
    expect(threadService).not.toContain('globalBridgeContinuationService');
  });
});
