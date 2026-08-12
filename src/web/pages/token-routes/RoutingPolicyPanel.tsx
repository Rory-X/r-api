import { useEffect, useMemo, useState } from 'react';
import { api, type RuntimeRoutingWeightsPayload } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import { Button, NumberField, SelectField, Switch } from '../../components/ui/index.js';
import {
  applyRoutingProfilePreset,
  resolveRoutingProfilePreset,
  type RoutingWeights,
} from '../helpers/routingProfiles.js';

const SECONDS_PER_DAY = 24 * 60 * 60;
const ROUTE_COOLDOWN_UNIT_OPTIONS = [
  { value: 'second', label: '秒', multiplierSec: 1 },
  { value: 'minute', label: '分钟', multiplierSec: 60 },
  { value: 'hour', label: '小时', multiplierSec: 60 * 60 },
  { value: 'day', label: '天', multiplierSec: SECONDS_PER_DAY },
] as const;

const DEFAULT_WEIGHTS: RoutingWeights = {
  baseWeightFactor: 0.5,
  valueScoreFactor: 0.5,
  costWeight: 0.4,
  balanceWeight: 0.3,
  usageWeight: 0.3,
};

type RouteCooldownUnit = typeof ROUTE_COOLDOWN_UNIT_OPTIONS[number]['value'];
type BalanceRoutingPolicyMode = 'observe_only' | 'soft_avoid' | 'hard_block';

type RoutingPolicyDraft = {
  firstByteRoutingPolicy: {
    enabled: boolean;
    baselineMs: number;
    penaltyWindowMs: number;
    maxPenaltyRatio: number;
    minSamples: number;
  };
  proxyFirstByteTimeoutSec: number;
  routeFailureCooldownMaxValue: number;
  routeFailureCooldownMaxUnit: RouteCooldownUnit;
  disableCrossProtocolFallback: boolean;
  routingFallbackUnitCost: number;
  routingWeights: RoutingWeights;
  balanceRoutingPolicy: {
    mode: BalanceRoutingPolicyMode;
    threshold: number;
    softAvoidMultiplier: number;
  };
};

const DEFAULT_DRAFT: RoutingPolicyDraft = {
  firstByteRoutingPolicy: {
    enabled: true,
    baselineMs: 2_500,
    penaltyWindowMs: 10_000,
    maxPenaltyRatio: 0.65,
    minSamples: 5,
  },
  proxyFirstByteTimeoutSec: 0,
  routeFailureCooldownMaxValue: 30,
  routeFailureCooldownMaxUnit: 'day',
  disableCrossProtocolFallback: false,
  routingFallbackUnitCost: 1,
  routingWeights: DEFAULT_WEIGHTS,
  balanceRoutingPolicy: {
    mode: 'observe_only',
    threshold: 0,
    softAvoidMultiplier: 0.1,
  },
};

function resolveRouteCooldownInput(seconds: number | null | undefined): {
  value: number;
  unit: RouteCooldownUnit;
} {
  const normalizedSeconds = Number.isFinite(Number(seconds)) && Number(seconds) > 0
    ? Math.max(1, Math.trunc(Number(seconds)))
    : 30 * SECONDS_PER_DAY;

  for (const option of [...ROUTE_COOLDOWN_UNIT_OPTIONS].reverse()) {
    if (normalizedSeconds % option.multiplierSec === 0) {
      return {
        value: normalizedSeconds / option.multiplierSec,
        unit: option.value,
      };
    }
  }

  return { value: normalizedSeconds, unit: 'second' };
}

function toRouteCooldownSeconds(value: number, unit: RouteCooldownUnit): number {
  const normalizedValue = Number.isFinite(value) && value > 0 ? Math.max(1, Math.trunc(value)) : 1;
  const unitConfig = ROUTE_COOLDOWN_UNIT_OPTIONS.find((option) => option.value === unit)
    || ROUTE_COOLDOWN_UNIT_OPTIONS[0];
  return normalizedValue * unitConfig.multiplierSec;
}

function normalizeWeights(value?: RuntimeRoutingWeightsPayload): RoutingWeights {
  return {
    baseWeightFactor: Number.isFinite(Number(value?.baseWeightFactor)) ? Number(value?.baseWeightFactor) : DEFAULT_WEIGHTS.baseWeightFactor,
    valueScoreFactor: Number.isFinite(Number(value?.valueScoreFactor)) ? Number(value?.valueScoreFactor) : DEFAULT_WEIGHTS.valueScoreFactor,
    costWeight: Number.isFinite(Number(value?.costWeight)) ? Number(value?.costWeight) : DEFAULT_WEIGHTS.costWeight,
    balanceWeight: Number.isFinite(Number(value?.balanceWeight)) ? Number(value?.balanceWeight) : DEFAULT_WEIGHTS.balanceWeight,
    usageWeight: Number.isFinite(Number(value?.usageWeight)) ? Number(value?.usageWeight) : DEFAULT_WEIGHTS.usageWeight,
  };
}

export default function RoutingPolicyPanel() {
  const toast = useToast();
  const [draft, setDraft] = useState<RoutingPolicyDraft>(DEFAULT_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const runtime = await api.getRuntimeSettings();
        if (!active) return;
        const cooldown = resolveRouteCooldownInput(runtime.tokenRouterFailureCooldownMaxSec);
        setDraft({
          firstByteRoutingPolicy: {
            enabled: runtime.firstByteRoutingPolicy?.enabled !== false,
            baselineMs: Number(runtime.firstByteRoutingPolicy?.baselineMs) > 0
              ? Math.trunc(Number(runtime.firstByteRoutingPolicy.baselineMs))
              : DEFAULT_DRAFT.firstByteRoutingPolicy.baselineMs,
            penaltyWindowMs: Number(runtime.firstByteRoutingPolicy?.penaltyWindowMs) > 0
              ? Math.trunc(Number(runtime.firstByteRoutingPolicy.penaltyWindowMs))
              : DEFAULT_DRAFT.firstByteRoutingPolicy.penaltyWindowMs,
            maxPenaltyRatio: Number(runtime.firstByteRoutingPolicy?.maxPenaltyRatio) >= 0
              ? Math.min(0.95, Number(runtime.firstByteRoutingPolicy.maxPenaltyRatio))
              : DEFAULT_DRAFT.firstByteRoutingPolicy.maxPenaltyRatio,
            minSamples: Number(runtime.firstByteRoutingPolicy?.minSamples) > 0
              ? Math.trunc(Number(runtime.firstByteRoutingPolicy.minSamples))
              : DEFAULT_DRAFT.firstByteRoutingPolicy.minSamples,
          },
          proxyFirstByteTimeoutSec: Number(runtime.proxyFirstByteTimeoutSec) >= 0
            ? Math.trunc(Number(runtime.proxyFirstByteTimeoutSec))
            : DEFAULT_DRAFT.proxyFirstByteTimeoutSec,
          routeFailureCooldownMaxValue: cooldown.value,
          routeFailureCooldownMaxUnit: cooldown.unit,
          disableCrossProtocolFallback: runtime.disableCrossProtocolFallback === true,
          routingFallbackUnitCost: Number(runtime.routingFallbackUnitCost) > 0
            ? Number(runtime.routingFallbackUnitCost)
            : DEFAULT_DRAFT.routingFallbackUnitCost,
          routingWeights: normalizeWeights(runtime.routingWeights),
          balanceRoutingPolicy: {
            mode: runtime.balanceRoutingPolicy?.mode === 'soft_avoid' || runtime.balanceRoutingPolicy?.mode === 'hard_block'
              ? runtime.balanceRoutingPolicy.mode
              : 'observe_only',
            threshold: Number(runtime.balanceRoutingPolicy?.threshold) >= 0
              ? Number(runtime.balanceRoutingPolicy.threshold)
              : DEFAULT_DRAFT.balanceRoutingPolicy.threshold,
            softAvoidMultiplier: Number(runtime.balanceRoutingPolicy?.softAvoidMultiplier) > 0
              ? Math.min(1, Number(runtime.balanceRoutingPolicy.softAvoidMultiplier))
              : DEFAULT_DRAFT.balanceRoutingPolicy.softAvoidMultiplier,
          },
        });
      } catch (error: any) {
        toast.error(error?.message || '加载调度策略失败');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [toast]);

  const activeProfile = useMemo(
    () => resolveRoutingProfilePreset(draft.routingWeights),
    [draft.routingWeights],
  );
  const minimumMultiplier = Math.max(0.05, 1 - draft.firstByteRoutingPolicy.maxPenaltyRatio);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateRuntimeSettings({
        firstByteRoutingPolicy: draft.firstByteRoutingPolicy,
        proxyFirstByteTimeoutSec: Math.max(0, Math.trunc(draft.proxyFirstByteTimeoutSec)),
        tokenRouterFailureCooldownMaxSec: toRouteCooldownSeconds(
          draft.routeFailureCooldownMaxValue,
          draft.routeFailureCooldownMaxUnit,
        ),
        disableCrossProtocolFallback: draft.disableCrossProtocolFallback,
        routingFallbackUnitCost: draft.routingFallbackUnitCost,
        routingWeights: draft.routingWeights,
        balanceRoutingPolicy: draft.balanceRoutingPolicy,
      });
      toast.success('调度策略已保存');
    } catch (error: any) {
      toast.error(error?.message || '保存调度策略失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="routing-policy-loading"><span className="spinner spinner-sm" /> 加载调度策略...</div>;
  }

  return (
    <div className="routing-policy-workspace">
      <section className="routing-policy-intro">
        <div>
          <h2>全局调度策略</h2>
          <p>Token Router 会综合实时健康、历史首字速度、成本、余额和使用频次选择上游渠道。</p>
        </div>
        <Button variant="primary" onClick={save} loading={saving} loadingLabel="保存中...">
          保存策略
        </Button>
      </section>

      <section className="routing-policy-section routing-policy-section-primary">
        <div className="routing-policy-section-heading">
          <div>
            <span className="routing-policy-kicker">跨请求自学习</span>
            <h3>历史首字时间调度</h3>
            <p>根据真实请求的首包 / 首 token EMA 自动降低慢渠道的后续选中概率，不把慢响应误判为故障。</p>
          </div>
          <Switch
            checked={draft.firstByteRoutingPolicy.enabled}
            onChange={(enabled) => setDraft((current) => ({
              ...current,
              firstByteRoutingPolicy: { ...current.firstByteRoutingPolicy, enabled },
            }))}
            label="启用首字速度学习"
            description="达到最低样本数后参与权重计算"
          />
        </div>

        <div className="routing-policy-fields routing-policy-fields-four">
          <NumberField
            label="目标首字基线"
            helperText="低于该值不降权"
            aria-label="首字调度基线毫秒"
            min={100}
            max={120000}
            step={100}
            value={draft.firstByteRoutingPolicy.baselineMs}
            disabled={!draft.firstByteRoutingPolicy.enabled}
            onChange={(event) => setDraft((current) => ({
              ...current,
              firstByteRoutingPolicy: {
                ...current.firstByteRoutingPolicy,
                baselineMs: Math.max(100, Math.trunc(Number(event.target.value) || 100)),
              },
            }))}
          />
          <NumberField
            label="降权窗口"
            helperText="超过基线后线性降权"
            aria-label="首字调度降权窗口毫秒"
            min={100}
            max={300000}
            step={100}
            value={draft.firstByteRoutingPolicy.penaltyWindowMs}
            disabled={!draft.firstByteRoutingPolicy.enabled}
            onChange={(event) => setDraft((current) => ({
              ...current,
              firstByteRoutingPolicy: {
                ...current.firstByteRoutingPolicy,
                penaltyWindowMs: Math.max(100, Math.trunc(Number(event.target.value) || 100)),
              },
            }))}
          />
          <NumberField
            label="最大降权"
            helperText={`最低保留 ${(minimumMultiplier * 100).toFixed(0)}% 权重`}
            aria-label="首字调度最大降权百分比"
            min={0}
            max={95}
            step={5}
            value={Math.round(draft.firstByteRoutingPolicy.maxPenaltyRatio * 100)}
            disabled={!draft.firstByteRoutingPolicy.enabled}
            onChange={(event) => setDraft((current) => ({
              ...current,
              firstByteRoutingPolicy: {
                ...current.firstByteRoutingPolicy,
                maxPenaltyRatio: Math.min(0.95, Math.max(0, Number(event.target.value) || 0) / 100),
              },
            }))}
          />
          <NumberField
            label="最低样本数"
            helperText="不足时保持原权重"
            aria-label="首字调度最低样本数"
            min={1}
            max={100}
            step={1}
            value={draft.firstByteRoutingPolicy.minSamples}
            disabled={!draft.firstByteRoutingPolicy.enabled}
            onChange={(event) => setDraft((current) => ({
              ...current,
              firstByteRoutingPolicy: {
                ...current.firstByteRoutingPolicy,
                minSamples: Math.min(100, Math.max(1, Math.trunc(Number(event.target.value) || 1))),
              },
            }))}
          />
        </div>

        <div className="routing-policy-curve-summary">
          <span><b>{draft.firstByteRoutingPolicy.baselineMs}ms 内</b> 100% 权重</span>
          <span><b>{draft.firstByteRoutingPolicy.baselineMs + draft.firstByteRoutingPolicy.penaltyWindowMs}ms 起</b> 最低 {(minimumMultiplier * 100).toFixed(0)}% 权重</span>
          <span><b>{draft.firstByteRoutingPolicy.minSamples} 次成功后</b> 开始参与调度</span>
        </div>
      </section>

      <section className="routing-policy-section">
        <div className="routing-policy-section-heading">
          <div>
            <span className="routing-policy-kicker">当前请求保护</span>
            <h3>失败切换与首字超时</h3>
            <p>这组设置控制单次请求何时放弃当前渠道，与上面的历史首字软降权相互独立。</p>
          </div>
        </div>
        <div className="routing-policy-fields routing-policy-fields-three">
          <NumberField
            label="首字超时（秒）"
            helperText="0 表示关闭；已经开始输出的请求不会被中断"
            aria-label="首字超时秒数"
            min={0}
            step={1}
            value={draft.proxyFirstByteTimeoutSec}
            onChange={(event) => setDraft((current) => ({
              ...current,
              proxyFirstByteTimeoutSec: Math.max(0, Math.trunc(Number(event.target.value) || 0)),
            }))}
          />
          <NumberField
            label="普通失败冷却上限"
            helperText="429 限额仍优先遵循上游 reset"
            aria-label="路由失败冷却上限数值"
            min={1}
            step={1}
            value={draft.routeFailureCooldownMaxValue}
            onChange={(event) => setDraft((current) => ({
              ...current,
              routeFailureCooldownMaxValue: Math.max(1, Math.trunc(Number(event.target.value) || 1)),
            }))}
          />
          <SelectField
            label="冷却单位"
            value={draft.routeFailureCooldownMaxUnit}
            onChange={(value) => setDraft((current) => ({
              ...current,
              routeFailureCooldownMaxUnit: value as RouteCooldownUnit,
            }))}
            options={ROUTE_COOLDOWN_UNIT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          />
        </div>
        <Switch
          checked={!draft.disableCrossProtocolFallback}
          onChange={(enabled) => setDraft((current) => ({
            ...current,
            disableCrossProtocolFallback: !enabled,
          }))}
          label="失败后允许尝试兼容协议"
          description="仅影响 chat / messages / responses 之间的协议切换；OAuth 刷新与同协议重试不受影响"
        />
      </section>

      <section className="routing-policy-section">
        <div className="routing-policy-section-heading">
          <div>
            <span className="routing-policy-kicker">候选评分</span>
            <h3>权重与价值偏好</h3>
            <p>预设决定候选的基础评分方式，首字与运行时健康倍率会在候选评分后继续生效。</p>
          </div>
          <Button variant="ghost" className="routing-policy-advanced-toggle" onClick={() => setShowAdvanced((current) => !current)}>
            {showAdvanced ? '收起高级权重' : '展开高级权重'}
          </Button>
        </div>
        <div className="routing-policy-presets" role="radiogroup" aria-label="路由策略预设">
          {([
            ['balanced', '均衡', '兼顾成本、余额与使用频次'],
            ['stable', '稳定优先', '提高基础权重和余额影响'],
            ['cost', '成本优先', '优先选择单位成本更低的渠道'],
          ] as const).map(([id, label, description]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={activeProfile === id}
              className={`routing-policy-preset ${activeProfile === id ? 'is-active' : ''}`.trim()}
              onClick={() => setDraft((current) => ({
                ...current,
                routingWeights: applyRoutingProfilePreset(id),
              }))}
            >
              <strong>{label}</strong>
              <span>{description}</span>
            </button>
          ))}
        </div>

        {showAdvanced && (
          <div className="routing-policy-fields routing-policy-fields-three routing-policy-advanced-fields">
            {([
              ['baseWeightFactor', '基础权重因子'],
              ['valueScoreFactor', '价值分因子'],
              ['costWeight', '成本权重'],
              ['balanceWeight', '余额权重'],
              ['usageWeight', '使用频次权重'],
            ] as Array<[keyof RoutingWeights, string]>).map(([key, label]) => (
              <NumberField
                key={key}
                label={label}
                min={0}
                step={0.1}
                value={draft.routingWeights[key]}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  routingWeights: {
                    ...current.routingWeights,
                    [key]: Math.max(0, Number(event.target.value) || 0),
                  },
                }))}
              />
            ))}
            <NumberField
              label="无价格信息时默认单价"
              helperText="用于缺少实测价、配置价和目录价的模型"
              min={0.000001}
              step={0.000001}
              value={draft.routingFallbackUnitCost}
              onChange={(event) => setDraft((current) => ({
                ...current,
                routingFallbackUnitCost: Math.max(0.000001, Number(event.target.value) || 0.000001),
              }))}
            />
          </div>
        )}
      </section>

      <section className="routing-policy-section">
        <div className="routing-policy-section-heading">
          <div>
            <span className="routing-policy-kicker">余额保护</span>
            <h3>余额路由策略</h3>
            <p>只使用成功刷新过的余额；未知余额不会被误判为不可用。</p>
          </div>
        </div>
        <div className="routing-policy-fields routing-policy-fields-three">
          <SelectField
            label="处理模式"
            value={draft.balanceRoutingPolicy.mode}
            onChange={(value) => setDraft((current) => ({
              ...current,
              balanceRoutingPolicy: {
                ...current.balanceRoutingPolicy,
                mode: value as BalanceRoutingPolicyMode,
              },
            }))}
            options={[
              { value: 'observe_only', label: '仅观察' },
              { value: 'soft_avoid', label: '低余额软避让' },
              { value: 'hard_block', label: '低余额硬阻断' },
            ]}
          />
          <NumberField
            label="余额阈值"
            min={0}
            step={0.01}
            value={draft.balanceRoutingPolicy.threshold}
            onChange={(event) => setDraft((current) => ({
              ...current,
              balanceRoutingPolicy: {
                ...current.balanceRoutingPolicy,
                threshold: Math.max(0, Number(event.target.value) || 0),
              },
            }))}
          />
          <NumberField
            label="软避让倍率"
            helperText="仅在低余额软避让模式下生效"
            min={0.01}
            max={1}
            step={0.05}
            value={draft.balanceRoutingPolicy.softAvoidMultiplier}
            onChange={(event) => setDraft((current) => ({
              ...current,
              balanceRoutingPolicy: {
                ...current.balanceRoutingPolicy,
                softAvoidMultiplier: Math.min(1, Math.max(0.01, Number(event.target.value) || 0.01)),
              },
            }))}
          />
        </div>
      </section>

      <div className="routing-policy-save-bar">
        <span>保存后立即应用到后续请求，无需重启服务。</span>
        <Button variant="primary" onClick={save} loading={saving} loadingLabel="保存中...">
          保存调度策略
        </Button>
      </div>
    </div>
  );
}
