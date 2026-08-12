import { tr } from '../../i18n.js';
import { normalizeRouteRoutingStrategy } from '../../../shared/routeRoutingStrategy.js';
import type { RouteRoutingStrategy } from './types.js';

export function normalizeRouteRoutingStrategyValue(value?: RouteRoutingStrategy | null): RouteRoutingStrategy {
  return normalizeRouteRoutingStrategy(value);
}

export function getRouteRoutingStrategyLabel(value?: RouteRoutingStrategy | null): string {
  const strategy = normalizeRouteRoutingStrategyValue(value);
  if (strategy === 'round_robin') return tr('轮询');
  if (strategy === 'stable_first') return tr('稳定优先');
  if (strategy === 'manual') return tr('手动调度');
  return tr('权重随机');
}

export function getRouteRoutingStrategyDescription(value?: RouteRoutingStrategy | null): string {
  const strategy = normalizeRouteRoutingStrategyValue(value);
  if (strategy === 'round_robin') {
    return tr('忽略 P 和 W，在全部可用通道中动态轮转；失败通道会自动冷却');
  }
  if (strategy === 'stable_first') {
    return tr('先按健康状态划分稳定主池与观察池，再按评分和配置顺位轮转');
  }
  if (strategy === 'manual') {
    return tr('P 越小越先调度；同一 P 层内严格按从上到下的顺序依次调用');
  }
  return tr('系统先锁定最高可用优先级，再综合权重、成本、健康与负载动态分配流量');
}

export function getRouteRoutingStrategyHint(value?: RouteRoutingStrategy | null): string {
  const strategy = normalizeRouteRoutingStrategyValue(value);
  if (strategy === 'round_robin') {
    return tr('通道列表仅用于查看当前状态，不代表下一次轮询的命中顺序。');
  }
  if (strategy === 'stable_first') {
    return tr('主池、观察池和轮转位置均由运行时状态决定。');
  }
  if (strategy === 'manual') {
    return tr('拖拽可调整优先级层和组内顺序；通道不可用时会继续尝试同层下一条。');
  }
  return tr('页面展示当前决策概率；自动调度下不提供 P/W 编辑。');
}
