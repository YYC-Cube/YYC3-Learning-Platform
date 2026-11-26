/**
 * Wave-13 全口径补测 — index.ts 公共导出面 + OptimizedIntelligentCacheLayer 主链
 * 背景：istanbul 全口径揭示 bun 口径漏计 index.ts（564 行 re-export）与
 *       OptimizedIntelligentCacheLayer.ts（967 行）两个 0% 文件——本文件闭环。
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as PublicAPI from './index';
import { OptimizedIntelligentCacheLayer, CacheLevel } from './core/OptimizedIntelligentCacheLayer';
import type { CacheMetadata } from './core/OptimizedIntelligentCacheLayer';

const meta = (): CacheMetadata => ({
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60000),
  priority: 'medium',
  version: 1,
  size: 10,
  accessCount: 0,
  lastAccessedAt: new Date(),
} as CacheMetadata);

describe('Wave-13 — index.ts 公共导出面冒烟（istanbul 全口径点亮）', () => {
  it('核心类与常量面', () => {
    expect(PublicAPI.ModelAdapter).toBeDefined();
    expect(PublicAPI.OpenAIProvider).toBeDefined();
    expect(PublicAPI.GoogleProvider).toBeDefined();
    expect(PublicAPI.EnhancedStreamingProcessor).toBeDefined();
    expect(new PublicAPI.ModelAdapter()).toBeDefined();
    expect(new PublicAPI.OpenAIProvider()).toBeDefined();
    expect(new PublicAPI.GoogleProvider()).toBeDefined();
    expect(PublicAPI.VERSION).toBe('1.0.0');
    expect(PublicAPI.DEFAULT_MODEL_ADAPTER_CONFIG.defaultModel).toBe('gpt-4');
    expect(PublicAPI.MODEL_PRESETS.openai.gpt4.model).toBe('gpt-4');
    expect(PublicAPI.MODEL_PRESETS.anthropic.claude3.model).toContain('claude');
    expect(PublicAPI.MODEL_PRESETS.google.gemini.model).toBe('gemini-pro');
    expect(typeof PublicAPI.createModelAdapter()).toBe('object');
  });

  it('工具函数群（request/id/token/cost/validate/select/format/capability/error）', () => {
    const req = PublicAPI.createModelRequest('generation', 'p', { maxTokens: 5 } as any);
    expect(req.id).toMatch(/^req_/);
    expect(req.maxTokens).toBe(5);
    expect(req.metadata?.priority).toBe('normal');
    expect(PublicAPI.generateId()).toMatch(/^req_/);

    expect(PublicAPI.estimateTokenCount('x'.repeat(40))).toBe(10);

    const cost = PublicAPI.calculateCost(1000, 2000, { inputTokensPer1K: 0.01, outputTokensPer1K: 0.03 } as any);
    expect(cost).toBeCloseTo(0.01 + 0.06, 6);

    const errs = PublicAPI.validateModelConfig({ id: 'x' } as any);
    expect(errs.length).toBeGreaterThanOrEqual(3);
    expect(PublicAPI.validateModelConfig({
      id: 'x', name: 'X', provider: 'openai', model: 'm',
      credentials: { apiKey: 'k' }, capabilities: {} as any,
    } as any)).toEqual([]);

    const models = [PublicAPI.MODEL_PRESETS.anthropic.claude3, PublicAPI.MODEL_PRESETS.openai.gpt4] as any[];
    // claude preset 的 model 为全称（claude-3-opus-20240229）不匹配首选短名 → 回退命中 gpt-4（实现语义如此）
    expect(PublicAPI.selectBestModelForTask('summarization' as any, models)?.id).toBe('gpt-4');
    expect(PublicAPI.selectBestModelForTask('generation' as any, models)?.id).toBe('gpt-4');
    expect(PublicAPI.selectBestModelForTask('generation' as any, [])).toBeNull();

    expect(PublicAPI.formatLatency(500)).toBe('500ms');
    expect(PublicAPI.formatLatency(1500)).toBe('1.50s');
    expect(PublicAPI.formatLatency(65000)).toContain('m');

    expect(PublicAPI.formatCost(1.5)).toContain('1.5');

    const gpt4 = PublicAPI.MODEL_PRESETS.openai.gpt4 as any;
    expect(PublicAPI.modelSupportsCapability(gpt4, 'functionCalling')).toBe(true);
    expect(PublicAPI.modelSupportsCapability(gpt4, 'visionSupport')).toBe(false);
    const caps = PublicAPI.getModelCapabilityNames(gpt4.capabilities);
    expect(caps).toContain('functionCalling');
    expect(caps).not.toContain('visionSupport');

    const errRes = PublicAPI.createErrorResponse('r1', 'm1', new Error('boom'));
    expect(errRes.finishReason).toBe('error');
    expect(errRes.content).toContain('boom');
    expect(errRes.usage.totalTokens).toBe(0);
  });
});

describe('Wave-13 — OptimizedIntelligentCacheLayer 写策略与多层提升', () => {
  let layer: OptimizedIntelligentCacheLayer;

  beforeEach(() => {
    layer = new OptimizedIntelligentCacheLayer({ l1Size: 100, l1TTL: 60000 } as any);
  });

  afterEach(async () => {
    await layer.clear();
  });

  it('write-through：set 四层写入 → L1 get hit（source L1）', async () => {
    await layer.set('wt-key', { v: 'wt' }, { strategy: 'write-through', ttl: 60000 });
    const res = await layer.get<{ v: string }>('wt-key');
    expect(res.hit).toBe(true);
    expect(res.source).toBe(CacheLevel.L1);
    expect(res.value).toEqual({ v: 'wt' });
  });

  it('write-behind：L1 即写 + 后台写 L2/L3/L4（setImmediate 异步落地）', async () => {
    await layer.set('wb-key', { v: 'wb' }, { strategy: 'write-behind', ttl: 60000 });
    const l1 = await layer.get('wb-key');
    expect(l1.hit).toBe(true);
    await new Promise((r) => setTimeout(r, 30)); // background write flush
    const l1c = (layer as any).l1Cache;
    await l1c.delete('wb-key');
    const viaL2 = await layer.get('wb-key');
    expect(viaL2.hit).toBe(true);
    expect(viaL2.source).toBe(CacheLevel.L2);
  });

  it('write-around：直写 L2/L3（绕过 L1）；invalidate: true 语义 = 写后立即失效', async () => {
    await layer.set('wa-key', { v: 'wa' }, { strategy: 'write-around', ttl: 60000 });
    const l1c = (layer as any).l1Cache;
    expect((await l1c.get('wa-key')).hit).toBe(false); // 绕过 L1
    expect((await layer.get('wa-key')).hit).toBe(true); // L2 命中

    await layer.set('wa-inv', { v: 'inv' }, { strategy: 'write-around', ttl: 60000, invalidate: true } as any);
    expect((await layer.get('wa-inv')).hit).toBe(false); // invalidate 刚写即失效
  });

  it('cache-aside：仅写 L1', async () => {
    await layer.set('ca-key', { v: 'ca' }, { strategy: 'cache-aside', ttl: 60000 });
    const res = await layer.get('ca-key');
    expect(res.hit).toBe(true);
    expect(res.source).toBe(CacheLevel.L1);
    const l2c = (layer as any).l2Cache;
    const l2direct = await l2c.get('ca-key');
    expect(l2direct.hit).toBe(false); // L2 未写
  });

  it('default 策略分支（未知 strategy → L1+L2 写）', async () => {
    await layer.set('def-key', { v: 'def' }, { strategy: 'exotic' as any, ttl: 60000 });
    const l1c = (layer as any).l1Cache;
    const l2c = (layer as any).l2Cache;
    expect((await l1c.get('def-key')).hit).toBe(true);
    expect((await l2c.get('def-key')).hit).toBe(true);
  });

  it('L2 提升：l1 逐出后 get 命中 L2 并回写 L1', async () => {
    await layer.set('promo2', { v: 2 }, { strategy: 'default' as any, ttl: 60000 });
    const l1c = (layer as any).l1Cache;
    await l1c.delete('promo2');
    const res = await layer.get('promo2');
    expect(res.source).toBe(CacheLevel.L2);
    expect((await l1c.get('promo2')).hit).toBe(true); // 回写验证
  });

  it('L3 提升：l1/l2 失配 → L3 hit + 双层回写', async () => {
    await layer.set('promo3', { v: 3 }, { strategy: 'write-through', ttl: 60000 });
    const l1c = (layer as any).l1Cache;
    const l2c = (layer as any).l2Cache;
    await l1c.delete('promo3');
    await l2c.delete('promo3');
    const res = await layer.get('promo3');
    expect(res.source).toBe(CacheLevel.L3);
    expect((await l1c.get('promo3')).hit).toBe(true);
    expect((await l2c.get('promo3')).hit).toBe(true);
  });

  it('L4 提升：l1/l2/l3 失配 → L4 hit + 三层回写', async () => {
    await layer.set('promo4', { v: 4 }, { strategy: 'write-through', ttl: 60000 });
    const l1c = (layer as any).l1Cache;
    const l2c = (layer as any).l2Cache;
    const l3c = (layer as any).l3Cache;
    await l1c.delete('promo4');
    await l2c.delete('promo4');
    await l3c.delete('promo4');
    const res = await layer.get('promo4');
    expect(res.source).toBe(CacheLevel.L4);
    expect((await l1c.get('promo4')).hit).toBe(true);
    expect((await l2c.get('promo4')).hit).toBe(true);
    expect((await l3c.get('promo4')).hit).toBe(true);
  });

  it('loader 路径：全 miss + loader → 回填 + source loader', async () => {
    const res = await layer.get('ld-key', { loader: async () => ({ v: 'loaded' }) } as any);
    expect(res.hit).toBe(false);
    expect(res.source).toBe('loader');
    expect(res.value).toEqual({ v: 'loaded' });
    const second = await layer.get('ld-key');
    expect(second.hit).toBe(true); // 回填生效
  });

  it('全 miss 无 loader → source none（value null）', async () => {
    const res = await layer.get('nope-key');
    expect(res.hit).toBe(false);
    expect(res.source).toBe('none');
    expect(res.value).toBeNull();
  });

  it('TTL 过期分支：短 ttl 后 get miss（内部类 expiresAt 检查）', async () => {
    await layer.set('ttl-key', { v: 'ttl' }, { strategy: 'cache-aside', ttl: 15 });
    await new Promise((r) => setTimeout(r, 40));
    const res = await layer.get('ttl-key');
    expect(res.hit).toBe(false);
  });

  it('evictLRU：l1Size=2 写 3 键 → evictions ≥ 1', async () => {
    const small = new OptimizedIntelligentCacheLayer({ l1Size: 2, l1TTL: 60000 } as any);
    await small.set('e1', 1, { strategy: 'cache-aside', ttl: 60000 });
    await small.set('e2', 2, { strategy: 'cache-aside', ttl: 60000 });
    await small.set('e3', 3, { strategy: 'cache-aside', ttl: 60000 });
    const stats = await small.getStats();
    expect(stats[0].evictions).toBeGreaterThanOrEqual(1);
    await small.clear();
  });
});

describe('Wave-13 — OptimizedIntelligentCacheLayer 批量/统计/预热/错误链', () => {
  let layer: OptimizedIntelligentCacheLayer;

  beforeEach(() => {
    layer = new OptimizedIntelligentCacheLayer({ l1Size: 100, l1TTL: 60000 } as any);
  });

  afterEach(async () => {
    await layer.clear();
  });

  it('getBatch/setBatch：多键批量读写', async () => {
    const entries = new Map<string, any>([
      ['b1', { v: 1 }],
      ['b2', { v: 2 }],
    ]);
    await layer.setBatch(entries, { strategy: 'write-through', ttl: 60000 });
    const results = await layer.getBatch<{ v: number }>(['b1', 'b2']);
    expect(results.get('b1')?.hit).toBe(true);
    expect(results.get('b2')?.value).toEqual({ v: 2 });
  });

  it('delete/deleteBatch/invalidate(regex)：定向失效', async () => {
    await layer.set('inv-user-1', 1, { strategy: 'write-through', ttl: 60000 });
    await layer.set('inv-user-2', 2, { strategy: 'write-through', ttl: 60000 });
    await layer.set('inv-other', 3, { strategy: 'write-through', ttl: 60000 });

    await layer.invalidate(/^inv-user-/);
    expect((await layer.get('inv-user-1')).hit).toBe(false);
    expect((await layer.get('inv-user-2')).hit).toBe(false);
    expect((await layer.get('inv-other')).hit).toBe(true);

    await layer.deleteBatch(['inv-other']);
    expect((await layer.get('inv-other')).hit).toBe(false);
  });

  it('getStats 四层数组 + analyzePerformance（低命中 → L1 bottleneck）', async () => {
    await layer.set('p1', 1, { strategy: 'write-through', ttl: 60000 });
    await layer.get('miss-1'); // miss
    const stats = await layer.getStats();
    expect(stats.length).toBe(4);

    const report = await layer.analyzePerformance();
    expect(report.metrics.totalHits).toBeGreaterThanOrEqual(0);
    expect(typeof report.healthScore).toBe('number');
    const l1Bottleneck = report.bottlenecks.find((b: any) => b.level === 'L1');
    expect(l1Bottleneck).toBeDefined(); // 少量请求下 hitRate < 0.8 恒成立
    expect(report.recommendations.length).toBe(report.bottlenecks.length);
  });

  it('warmup：固定 3 键识别 + loader 成功/失败混合 report', async () => {
    let calls = 0;
    const report = await layer.warmup([
      {
        name: 'w1',
        ttl: 60000,
        loader: async (key: string) => {
          calls++;
          if (key === 'key_2') throw new Error('warm-fail');
          return { key, at: Date.now() };
        },
      } as any,
    ]);
    expect(report.patterns.length).toBe(1);
    expect(report.patterns[0].keysAttempted).toBe(3);
    expect(report.patterns[0].keysWarmed).toBe(2); // key_2 失败
    expect(report.results.w1.find((r: any) => !r.success)?.error).toBe('warm-fail');
    expect(calls).toBe(3);
    expect(report.totalDuration).toBeGreaterThanOrEqual(0);
  });

  it('handleCacheError：层错误 + loader 降级 / 无 loader 透传', async () => {
    (layer as any).l1Cache.get = async () => {
      throw new Error('l1 boom');
    };

    const degraded = await layer.get('err-key', { loader: async () => 'fallback' } as any);
    expect(degraded.source).toBe('loader');
    expect(degraded.value).toBe('fallback');

    await expect(layer.get('err-key2')).rejects.toThrow('l1 boom');
  });

  it('事件面：cache:set/hit/miss/error 全量 emit 断言', async () => {
    const events: string[] = [];
    layer.on('cache:set', () => events.push('set'));
    layer.on('cache:hit', () => events.push('hit'));
    layer.on('cache:miss', () => events.push('miss'));
    layer.on('cache:error', () => events.push('error'));

    await layer.set('ev-key', 1, { strategy: 'write-through', ttl: 60000 });
    await layer.get('ev-key'); // hit
    await layer.get('ev-miss'); // miss
    (layer as any).l1Cache.get = async () => {
      throw new Error('boom');
    };
    try {
      await layer.get('ev-err');
    } catch {
      /* loader 无 → 透传，error 已 emit */
    }

    expect(events).toContain('set');
    expect(events).toContain('hit');
    expect(events).toContain('miss');
    expect(events).toContain('error');
  });

  it('findKeys 跨层合并去重（write-through 四层同键）', async () => {
    await layer.set('fk-a', 1, { strategy: 'write-through', ttl: 60000 });
    await layer.set('fk-b', 2, { strategy: 'write-through', ttl: 60000 });
    // 白盒：私有 findKeys 跨层合并
    const keys = await (layer as any).findKeys(/^fk-/);
    expect(keys.sort()).toEqual(['fk-a', 'fk-b']);
  });
});
