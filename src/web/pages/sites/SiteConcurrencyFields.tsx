import { MAX_SITE_CONCURRENCY, MAX_SITE_CONCURRENCY_WAIT_MS } from '../../../shared/siteConcurrency.js';
import type { CSSProperties } from 'react';
import ResponsiveFormGrid from '../../components/ResponsiveFormGrid.js';
import type { SiteForm } from '../helpers/sitesEditor.js';

type Values = Pick<SiteForm, 'maxConcurrency' | 'concurrencyWaitTimeoutMs'>;
export default function SiteConcurrencyFields({ values, onChange, inputStyle }: {
  values: Values;
  onChange: (values: Values) => void;
  inputStyle?: CSSProperties;
}) {
  return <div style={{ marginTop: 16 }}>
    <ResponsiveFormGrid>
      <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
        站点总并发上限
        <input type="number" min={1} max={MAX_SITE_CONCURRENCY} step={1} placeholder="留空表示不限制" value={values.maxConcurrency}
          onChange={(event) => onChange({ ...values, maxConcurrency: event.target.value })} style={inputStyle} />
      </label>
      <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
        并发等待时间（毫秒）
        <input type="number" min={0} max={MAX_SITE_CONCURRENCY_WAIT_MS} step={1} value={values.concurrencyWaitTimeoutMs}
          onChange={(event) => onChange({ ...values, concurrencyWaitTimeoutMs: event.target.value })} style={inputStyle} />
      </label>
    </ResponsiveFormGrid>
    <p style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
      限制整个部署中该站点所有账号和下游 Key 的合计活跃请求；多个副本必须共享同一数据库。
      流式请求保持占用直到结束，WebSocket 按生成请求计数。等待时间为 0 时，容量不足立即返回 503。
    </p>
  </div>;
}
