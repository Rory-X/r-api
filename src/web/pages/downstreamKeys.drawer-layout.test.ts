import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('DownstreamKeys drawer layout', () => {
  it('uses the shared right drawer for view and edit while keeping create centered', () => {
    const overviewSource = readFileSync(
      resolve(process.cwd(), 'src/web/pages/downstream-keys/DownstreamKeyDrawer.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const editorSource = readFileSync(
      resolve(process.cwd(), 'src/web/pages/downstream-keys/DownstreamKeyEditorModal.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8').replace(/\r\n/g, '\n');

    expect(overviewSource).toContain("import SideDrawer from '../../components/SideDrawer.js'");
    expect(overviewSource).toContain('<SideDrawer');
    expect(editorSource).toContain('const EditorSurface = editingItem ? SideDrawer : CenteredModal;');
    expect(editorSource).toContain('maxWidth={editingItem ? 760 : 860}');

    expect(css).toMatch(/\.side-drawer-root\s*{[^}]*justify-content:\s*flex-end;/s);
    expect(css).toMatch(/\.side-drawer-panel\s*{[^}]*height:\s*100dvh;[^}]*animation:\s*drawer-slide-in-right/s);
    expect(css).toMatch(/\.side-drawer-body\s*{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
    expect(css).toMatch(/\.side-drawer-footer\s*{[^}]*flex:\s*0 0 auto;/s);
  });
});
