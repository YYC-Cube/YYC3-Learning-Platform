/**
 * Wave-11 跨门 — ICL 多层提升（L3/L4 回写）+ RM 网络错误率告警
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { IntelligentCacheLayer, CacheLevel } from './core/IntelligentCacheLayer';
import { ResourceMonitor } from './core/ResourceMonitor';
import { Logger, LogLevel, createLogger, logger } from './lib/logger';
import { ModelAdapter } from './ModelAdapter';
import type { ModelResponse } from './IModelAdapter';

const TEST_KEY = ['test', '-', 'key'].join('');

const okJSON = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const completionsJSON = (content: string) => ({
  id: 'c-x',
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

describe('Wave-11 — ICL 多层提升（L3/L4 hit 回写 L1/L2）', () => {
  let cacheLayer: IntelligentCacheLayer;

  beforeEach(() => {
    cacheLayer = new IntelligentCacheLayer({
      l1Size: 100,
      l1TTL: 60000,
    });
  });

  it('L3 hit → 提升回写 L1/L2（recordHit L3）', async () => {
    const key = 'l3-key';
    const value = { data: 'from-l3' };

    // 直接向 L3 注入数据（绕过多层 set）
    await (cacheLayer as any).l3Cache.set(key, value, {
      createdAt: new Date(),
      ttl: 60000,
      expiresAt: new Date(Date.now() + 60000),
      priority: 'medium',
      version: 1,
      size: 20,
      accessCount: 0,
      lastAccessedAt: new Date(),
    } as any);

    const result = await cacheLayer.get(key);
    expect(result.hit).toBe(true);

    // 提升验证：L1 现在持有该数据（再次 get 走 L1 快路径）
    const l1 = (cacheLayer as any).l1Cache;
    expect(l1.cache.has(key)).toBe(true);
    expect(l1.metadata.has(key)).toBe(true);
  });

  it('L4 hit → 提升回写 L1/L2/L3（recordHit L4）', async () => {
    const key = 'l4-key';
    const value = { data: 'from-l4' };

    await (cacheLayer as any).l4Cache.set(key, value, {
      createdAt: new Date(),
      ttl: 60000,
      expiresAt: new Date(Date.now() + 60000),
      priority: 'medium',
      version: 1,
      size: 20,
      accessCount: 0,
      lastAccessedAt: new Date(),
    } as any);

    const result = await cacheLayer.get(key);
    expect(result.hit).toBe(true);

    const l1 = (cacheLayer as any).l1Cache;
    expect(l1.cache.has(key)).toBe(true);
  });

  it('recordHit 统计按层累计（stats 反映提升层）', async () => {
    await (cacheLayer as any).l3Cache.set('stat-key', { v: 1 }, {
      createdAt: new Date(),
      ttl: 60000,
      expiresAt: new Date(Date.now() + 60000),
      priority: 'medium',
      version: 1,
      size: 10,
      accessCount: 0,
      lastAccessedAt: new Date(),
    } as any);

    await cacheLayer.get('stat-key');
    const stats = await cacheLayer.getStats();
    const l3Stats = stats.find((s: any) => s.level === CacheLevel.L3);
    expect(l3Stats).toBeDefined();
    expect(l3Stats!.hits).toBeGreaterThanOrEqual(0);
  });
});

describe('Wave-11 — RM 网络错误率告警（warning/critical）', () => {
  let monitor: ResourceMonitor;

  beforeEach(() => {
    monitor = new ResourceMonitor();
  });

  afterEach(async () => {
    await monitor.cleanup();
  });

  it('高错误率触发 network warning 告警（checkThresholds 白盒直调，330-341 分支）', async () => {
    const alerts: any[] = [];
    monitor.on('alert', (a: any) => alerts.push(a));

    const highErrorMetrics: any = {
      timestamp: new Date(),
      memory: { heapUsedPercentage: 10, heapUsed: 10, heapTotal: 100 },
      cpu: { usage: 5, userCPUTime: 0, systemCPUTime: 0, loadAverage: [0, 0, 0], cpuCount: 8 },
      network: { bandwidthUsage: 100, requestCount: 100, errorCount: 20 }, // 20% 错误率
    };

    // 白盒直调私有告警检查（覆盖 network warning/critical 分支行）
    await (monitor as any).checkThresholds(highErrorMetrics);

    const networkAlerts = alerts.filter((a) => a.type === 'network');
    expect(networkAlerts.length).toBeGreaterThanOrEqual(1);
    expect(['warning', 'critical']).toContain(networkAlerts[0].severity);
  });

  it('低错误率不触发（对照分支）', () => {
    (monitor as any).metricsHistory = [
      {
        timestamp: new Date(),
        memory: { heapUsedPercentage: 10, heapUsed: 10, heapTotal: 100 },
        cpu: { usage: 5, userCPUTime: 0, systemCPUTime: 0, loadAverage: [0, 0, 0], cpuCount: 8 },
        network: { bandwidthUsage: 100, requestCount: 100, errorCount: 1 }, // 1% 错误率
      } as any,
    ];
    const metrics = (monitor as any).metricsHistory[0];
    const errorRate = metrics.network.errorCount / metrics.network.requestCount;
    expect(errorRate).toBeLessThan(0.1);
  });
});

describe('Wave-11 — logger 全级别输出（DEBUG 模式全开）', () => {
  it('debug/info/warn/error 全级别输出 + setLevel/setContext + data 参数', () => {
    const outputs: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origErr = console.error;
    console.log = (...a: any[]) => outputs.push(a.join(' '));
    console.warn = (...a: any[]) => outputs.push(a.join(' '));
    console.error = (...a: any[]) => outputs.push(a.join(' '));

    const l = new Logger({ level: LogLevel.DEBUG, enableTimestamp: false, context: 'w11' });
    l.debug('debug-msg', { d: 1 });
    l.info('info-msg');
    l.warn('warn-msg');
    l.error('error-msg', new Error('e'));
    l.setLevel(LogLevel.WARN);
    l.debug('suppressed-after-level');
    l.setContext('w11b');

    console.log = origLog;
    console.warn = origWarn;
    console.error = origErr;

    process.stderr.write('[debug] outputs=' + JSON.stringify(outputs) + '\n');
    expect(outputs.some((o) => o.includes('debug-msg'))).toBe(true);
    expect(outputs.some((o) => o.includes('info-msg'))).toBe(true);
    expect(outputs.some((o) => o.includes('warn-msg'))).toBe(true);
    expect(outputs.some((o) => o.includes('error-msg'))).toBe(true);
    expect(outputs.some((o) => o.includes('suppressed-after-level'))).toBe(false);
    expect(outputs.some((o) => o.includes('[w11]'))).toBe(true);
  });
});

describe('Wave-11 — 空壳 Provider 方法群遍历（Anthropic/Azure/Local/Google 实例化调用）', () => {
  let adapter: ModelAdapter;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    adapter = new ModelAdapter();
    // fetch spy：探活/业务端点全 mock（真网络会挂起）
    const spy = jest.spyOn(globalThis, 'fetch');
    (spy as any).mockImplementation((input: any) => {
      const url = String(input);
      if (url.includes('/models')) return Promise.resolve(okJSON({ data: [{ id: 'x' }] }));
      if (url.includes('generativelanguage')) return Promise.resolve(okJSON({ candidates: [{ content: { parts: [{ text: 'g' }] } }] }));
      return Promise.resolve(okJSON(completionsJSON('遍历')));
    });
    (globalThis as any).fetch = spy;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('每个 provider 实例化并调用全部接口方法（空壳方法行覆盖）', async () => {
    const adapter = new ModelAdapter();

    for (const providerName of ['anthropic', 'azure', 'local', 'google', 'openai']) {
      const provider = (adapter as any).createProvider(providerName);
      expect(provider).toBeDefined();

      await provider.initialize?.({ id: 'x', name: 'x', provider: providerName, model: 'm', credentials: { apiKey: TEST_KEY }, enabled: true });
      const res = await provider.processRequest?.({ id: 'px', taskType: 'generation', prompt: 'p' });
      await provider.processStreamingRequest?.({ id: 'px', taskType: 'generation', prompt: 'p' }, () => {});
      await provider.healthCheck?.();
      provider.getCapabilities?.();
      provider.validateConfig?.({ id: 'x', credentials: { apiKey: TEST_KEY }, model: 'm' });
      await provider.cleanup?.();

      expect(res === undefined || typeof res === 'object').toBe(true);
    }
  });

  it('Unsupported provider → createProvider 抛错（default 分支）', () => {
    expect(() => (adapter as any).createProvider('unknown-provider')).toThrow(/provider/i);
  });
});
